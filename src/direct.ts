// The direct path: a claude.ai connector called through Anthropic's connector proxy with Claude Code's own
// claude.ai login, without starting Claude Code (583 ms against 2010 ms per call, docs/research/startup.md).
// Claude Code stays the fallback, and the only one that renews the login.
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import type { ClaudeConnectors, ConnectorServer, ControlRequest } from "./bridge/client";
import type { Manifest } from "./cache";
import { requireConnected } from "./connected";
import { fail } from "./errors";
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
// Connection errors that mean nothing was sent: Bun's and Node's codes for a refused connection and a failed DNS
// lookup (observed on Bun 1.4 and Node 22 and 26). A reset or close can come after the request left: not here.
const NOT_SENT = new Set(["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
/** The request left and no full answer came back: the tool may have run. TIMEOUT, which a write records as unknown. */
const mayHaveRun = (what: string) => fail("TIMEOUT", `Timed out waiting for mcp_call: ${what}; the connector may have run it`);

/** A session that calls connectors direct, and starts Claude Code only when it has to: no usable login, a login
 * expiring within a minute, a connector without a cached ID, or a request the proxy refused before the tool ran
 * (HTTP 400, 401, 403, 404, or no connection). After a send nothing falls back: a timeout, a 5xx or a 429 is
 * reported as it is, so a write is never sent twice. Once fallen back, the rest of the session is Claude Code's. */
export class DirectSession {
  private login?: Login;
  private readonly tools = new Map<string, { id?: string; name: string; manifest: Manifest }>();
  private direct?: boolean; // decided on first use: the login is read only by a session that is used
  /** Why calls go through Claude Code, once they do (doctor reports it). */
  notDirect?: string;
  private claude?: Promise<Client>;
  private discovered: ConnectorServer[] = []; // Claude Code's list once it started, for the same check as without the direct path
  private readonly clientSession = crypto.randomUUID();

  constructor(private readonly needs: Manifest[], private readonly openClaude: () => Promise<Client>, private readonly deps: DirectDeps = { login: readLogin, fetch }) {
    for (const m of needs) for (const t of m.tools) this.tools.set(t.sourceName, { id: typeof m.server?.id === "string" ? m.server.id : undefined, name: t.name, manifest: m });
  }

  private isDirect() {
    if (this.direct === undefined) {
      const missing = this.needs.find(m => typeof m.server?.id !== "string");
      const login = missing ? undefined : this.deps.login();
      this.notDirect = missing ? `${missing.connectorName} has no connector ID cached (run \`plugboard refresh\`)`
        : !login ? "no claude.ai login found"
        : login.expiresAt !== undefined && login.expiresAt - Date.now() <= 60_000 ? "the claude.ai login expires within a minute"
        : login.scopes !== undefined && !login.scopes.includes("user:mcp_servers") ? "the claude.ai login has no connector access (user:mcp_servers)"
        : undefined;
      this.direct = this.notDirect === undefined;
      if (this.direct) this.login = login;
    }
    return this.direct;
  }

  /** Claude Code, started once, with the session's connectors discovered: a call right after a start would find them pending. */
  private fallback(reason?: string): Promise<Client> {
    if (this.direct) this.notDirect = reason;
    this.direct = false;
    return (this.claude ??= this.openClaude().then(async client => {
      this.discovered = await client.waitForServers([...new Set(this.needs.map(m => m.connectorName))]);
      return client;
    }));
  }

  async waitForServers(names?: string[]): Promise<ConnectorServer[]> {
    if (!this.isDirect()) return (await this.fallback()).waitForServers(names);
    // The proxy has no status call: a connector that is no longer connected refuses the call, which falls back.
    return this.needs.map(m => ({ name: m.connectorName, status: "connected", config: m.server, tools: m.tools.map(t => ({ name: t.name })) }));
  }

  async request<T = Record<string, unknown>>(request: ControlRequest, options: { timeoutMs?: number } = {}): Promise<T> {
    if (request.subtype === "mcp_call") {
      const tool = this.tools.get(String(request.tool));
      let refused: string | undefined;
      if (tool?.id && this.isDirect()) {
        try { return await this.call({ id: tool.id, name: tool.name }, request.arguments, options.timeoutMs ?? 35_000) as T; } catch (error) {
          if (!(error instanceof Refused)) throw error;
          refused = error.message;
        }
      }
      const client = await this.fallback(refused);
      // As without the direct path: a connector Claude Code doesn't list as connected is refused before the call.
      if (tool) requireConnected(this.discovered, tool.manifest);
      return client.request<T>(request, options);
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
      // Plugboard's own words only: a fetch error can quote the request's headers, and so the login.
      const e = error as Error & { code?: string; cause?: { code?: string } };
      const code = e.code ?? e.cause?.code;
      if (NOT_SENT.has(code ?? "")) throw new Refused(`could not connect to the connector proxy (${code})`);
      if (e.name === "TimeoutError" || e.name === "AbortError") throw mayHaveRun("no answer in time");
      throw mayHaveRun(`the connection to the connector proxy failed (${code ?? e.name})`);
    }
    if ([400, 401, 403, 404].includes(res.status)) { await res.body?.cancel().catch(() => {}); throw new Refused(`the connector proxy refused the call (${res.status})`); }
    let text: string;
    try { text = await res.text(); } catch (error) {
      const e = error as Error & { code?: string; cause?: { code?: string } };
      throw mayHaveRun(e.name === "TimeoutError" || e.name === "AbortError" ? "the answer didn't finish in time" : `the answer was cut off (${e.code ?? e.cause?.code ?? e.name})`);
    }
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
