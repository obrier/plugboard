// The direct path: a claude.ai connector called through Anthropic's connector proxy with Claude Code's own
// claude.ai login, without starting Claude Code (583 ms against 2010 ms per call, docs/research/startup.md).
// Claude Code stays the fallback, and the only one that renews the login.
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import type { ClaudeConnectors, ConnectorServer, ControlRequest } from "./bridge/client";
import type { Manifest } from "./cache";
import { runtime } from "./runtime";

/** The one host the direct path talks to: Anthropic's MCP proxy for claude.ai connectors. It serves connector
 * tools only, so no request from here can reach a model; that is what keeps a direct session at $0. */
export const PROXY_ORIGIN = "https://mcp-proxy.anthropic.com";
const PROTOCOL = "2025-11-25"; // the proxy refuses newer protocol versions (checked 2026-11-05)

export type Login = { accessToken: string; expiresAt?: number; scopes?: string[] };
type Client = Pick<ClaudeConnectors, "request" | "waitForServers" | "close">;
export type DirectDeps = { login: () => Login | undefined; fetch: typeof fetch };

/** On unless PLUGBOARD_DIRECT=0. Off with a custom CLAUDE_CONFIG_DIR, where Claude Code may keep its login
 * under another name (unverified). */
export function directEnabled(env = process.env) {
  return env.PLUGBOARD_DIRECT !== "0" && !env.CLAUDE_CONFIG_DIR;
}

/** Claude Code's claude.ai login, where it keeps it: the macOS keychain, or ~/.claude/.credentials.json elsewhere.
 * Read for each session, in memory only, never written or printed. */
export function readLogin(): Login | undefined {
  try {
    const raw = process.platform === "darwin"
      ? runtime.spawnSync(["security", "find-generic-password", "-a", userInfo().username, "-w", "-s", "Claude Code-credentials"], { env: process.env })
      : { exitCode: 0, stdout: readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8") };
    if (raw.exitCode !== 0) return undefined;
    const login = JSON.parse(raw.stdout).claudeAiOauth;
    return typeof login?.accessToken === "string" ? login : undefined;
  } catch { return undefined; }
}

/** The request was refused before the tool ran: safe to make again through Claude Code. */
class Refused extends Error {}
// Connection errors that mean nothing was sent (Bun's codes, then Node's).
const NOT_SENT = new Set(["ConnectionRefused", "FailedToOpenSocket", "ConnectionClosed", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** A session that calls connectors direct, and starts Claude Code only when it has to: no usable login, a login
 * expiring within a minute, a connector without a cached ID, or a request the proxy refused before the tool ran
 * (HTTP 400, 401, 403, 404, or no connection). After a send nothing falls back: a timeout, a 5xx or a 429 is
 * reported as it is, so a write is never sent twice. Once fallen back, the rest of the session is Claude Code's. */
export class DirectSession {
  private login?: Login;
  private readonly tools = new Map<string, { id: string; name: string }>();
  private direct?: boolean; // decided on first use: the login is read only by a session that is used
  private claude?: Promise<Client>;
  private readonly clientSession = crypto.randomUUID();

  constructor(private readonly needs: Manifest[], private readonly openClaude: () => Promise<Client>, private readonly deps: DirectDeps = { login: readLogin, fetch }) {
    for (const m of needs) if (typeof m.server?.id === "string") for (const t of m.tools) this.tools.set(t.sourceName, { id: m.server.id, name: t.name });
  }

  private isDirect() {
    if (this.direct === undefined) {
      const ids = this.needs.every(m => typeof m.server?.id === "string");
      const login = ids ? this.deps.login() : undefined;
      this.direct = !!login && (login.expiresAt === undefined || login.expiresAt - Date.now() > 60_000)
        && (login.scopes === undefined || login.scopes.includes("user:mcp_servers"));
      if (this.direct) this.login = login;
    }
    return this.direct;
  }

  /** Claude Code, started once, with the session's connectors discovered: a call right after a start would find them pending. */
  private fallback(): Promise<Client> {
    this.direct = false;
    return (this.claude ??= this.openClaude().then(async client => {
      await client.waitForServers([...new Set(this.needs.map(m => m.connectorName))]);
      return client;
    }));
  }

  async waitForServers(names?: string[]): Promise<ConnectorServer[]> {
    if (!this.isDirect()) return (await this.fallback()).waitForServers(names);
    // The proxy has no status call: a connector that is no longer connected refuses the call, which falls back.
    return this.needs.map(m => ({ name: m.connectorName, status: "connected", config: m.server, tools: m.tools.map(t => ({ name: t.name })) }));
  }

  async request<T = Record<string, unknown>>(request: ControlRequest, options: { timeoutMs?: number } = {}): Promise<T> {
    if (request.subtype === "mcp_call" && this.isDirect()) {
      const tool = this.tools.get(String(request.tool));
      if (tool) {
        try { return await this.call(tool, request.arguments, options.timeoutMs ?? 35_000) as T; } catch (error) { if (!(error instanceof Refused)) throw error; }
      }
    }
    // Nothing but the proxy was reached while Claude Code never started: the session's cost is zero by construction.
    if (request.subtype === "get_session_cost" && !this.claude)
      return { text: "Total cost: $0.0000 (connector proxy only)\nUsage: 0 input, 0 output, 0 cache read, 0 cache write" } as T;
    return (await this.fallback()).request<T>(request, options);
  }

  async close() { if (this.claude) await (await this.claude.catch(() => undefined))?.close(); }

  private async call(tool: { id: string; name: string }, args: unknown, timeoutMs: number) {
    let res: Response;
    try {
      res = await this.deps.fetch(`${PROXY_ORIGIN}/v1/mcp/${tool.id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.login!.accessToken}`, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL,
          "X-Mcp-Client-Session-Id": this.clientSession, "User-Agent": `plugboard/${version}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: args ?? {} } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const e = error as Error & { code?: string; cause?: { code?: string } };
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error("Timed out waiting for mcp_call");
      if (NOT_SENT.has(e.code ?? "") || NOT_SENT.has(e.cause?.code ?? "")) throw new Refused(e.message);
      throw error;
    }
    if ([400, 401, 403, 404].includes(res.status)) { await res.body?.cancel(); throw new Refused(`connector proxy ${res.status}`); }
    const text = await res.text();
    if (!res.ok) throw new Error(`connector proxy ${res.status}: ${text.slice(0, 200)}`);
    const message = parse(text, res.headers.get("content-type") ?? "");
    if (message?.error) throw new Error(String(message.error.message ?? "connector proxy error"));
    if (!message || typeof message.result !== "object") throw new Error("connector proxy: no result in the answer");
    return message.result as Record<string, unknown>;
  }
}

/** A JSON-RPC answer, sent as JSON or as an event stream whose last message carries it. */
function parse(text: string, type: string): { result?: unknown; error?: { message?: unknown } } | undefined {
  try {
    if (!type.includes("text/event-stream")) return JSON.parse(text);
    let found;
    for (const line of text.split("\n")) if (line.startsWith("data: ")) { const m = JSON.parse(line.slice(6)); if ("result" in m || "error" in m) found = m; }
    return found;
  } catch { return undefined; }
}
