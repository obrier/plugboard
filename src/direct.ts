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
import { fail, markNotSent } from "./errors";
import { runtime } from "./runtime";

/** The one host the direct path talks to: Anthropic's MCP proxy for claude.ai connectors. It serves connector
 * tools only, so no request from here can reach a model; that is what keeps a direct session at $0. */
export const PROXY_ORIGIN = "https://mcp-proxy.anthropic.com";
const PROTOCOL = "2025-11-25"; // the proxy refuses newer protocol versions (checked 2026-11-05)

export type Login = { accessToken: string; expiresAt?: number; scopes?: string[] };
type Client = Pick<ClaudeConnectors, "request" | "waitForServers" | "close">;
export type DirectDeps = { login: () => Login | undefined; fetch: typeof fetch };

/** How a call reaches its connector: direct to the proxy with Claude Code as the fallback (auto), direct only, or
 * always through Claude Code. A result's `via` names the path that served it, in the same words. */
export const TRANSPORTS = ["auto", "direct", "claude-code"] as const;
export type Transport = (typeof TRANSPORTS)[number];
export type Via = Exclude<Transport, "auto">;

/** The narrowest setting wins: the call's (or the instance's), PLUGBOARD_TRANSPORT, then the policy's `transport`.
 * PLUGBOARD_DIRECT=0 (0.1.3) still means claude-code. Auto stays on Claude Code with a custom CLAUDE_CONFIG_DIR, where
 * Claude Code may keep its login under another name (unverified). */
export function resolveTransport(policy: { transport?: Transport }, override?: Transport, env = process.env): Transport {
  const fromEnv = env.PLUGBOARD_TRANSPORT || (env.PLUGBOARD_DIRECT === "0" ? "claude-code" : undefined);
  const chosen = override ?? fromEnv ?? policy.transport ?? "auto";
  if (!TRANSPORTS.includes(chosen as Transport))
    throw fail("VALIDATION_ERROR", `Unknown transport "${chosen}" (one of ${TRANSPORTS.join(", ")})`, ["Set it in policy.toml or PLUGBOARD_TRANSPORT"]);
  return chosen === "auto" && env.CLAUDE_CONFIG_DIR ? "claude-code" : chosen as Transport;
}

/** Results the proxy served, as against Claude Code: `via` without changing the result's shape. */
const served = new WeakSet<object>();
export const viaOf = (result: object): Via => (served.has(result) ? "direct" : "claude-code");

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

/** The request was refused before the tool ran: safe to make again through Claude Code. `status` is the HTTP
 * refusal's, none for a connection that never opened. */
class Refused extends Error { constructor(message: string, readonly status?: number) { super(message); } }
// Connection errors that mean nothing was sent: Bun's and Node's codes for a refused connection and a failed DNS
// lookup (observed on Bun 1.4 and Node 22 and 26). A reset or close can come after the request left: not here.
const NOT_SENT = new Set(["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
/** The request left and no full answer came back: the tool may have run. TIMEOUT, which a write records as unknown. */
const mayHaveRun = (what: string) => fail("TIMEOUT", `Timed out waiting for mcp_call: ${what}; the connector may have run it`);
/** A login this close to expiring is read again before a call: Claude Code may have renewed it. */
const REREAD_MS = 5 * 60_000;
/** A login this close to expiring isn't used: the call goes through Claude Code, which renews it. */
const EXPIRING_MS = 60_000;

/** A session that calls connectors direct, and goes through Claude Code only for a call it has to: a connector
 * without a cached ID, no usable login (none, expiring within a minute, without connector access, or one the proxy
 * refused), or a request the proxy refused before the tool ran (HTTP 400, 401, 403, 404, or no connection). After a
 * send nothing falls back: a timeout, a 5xx or a 429 is reported as it is, so a write is never sent twice.
 *
 * It lasts as long as its user wants: connectors are taken on as they're first called (`use`), each call decides
 * again (a login near expiry is read again first), and a connector the proxy refused stays with Claude Code. Claude
 * Code, once started, closes itself after `idleMs` without a call and starts again when one needs it.
 * With `fallback: false` (transport "direct") it never starts Claude Code: what would fall back is UNREACHABLE. */
export class DirectSession {
  private login?: Login; // the login last read
  private refusedToken?: string; // a login the proxy answered 401 to: not sent again
  private readonly refused = new Map<string, string>(); // connector id → why the proxy refused it (400, 403, 404)
  private readonly manifests: Manifest[] = [];
  private readonly tools = new Map<string, { id?: string; name: string; manifest: Manifest }>();
  /** Why the last call went through Claude Code (doctor reports it); nothing once a call goes direct. */
  notDirect?: string;
  private claude?: Promise<Client>;
  private discovered: ConnectorServer[] = []; // Claude Code's last list, for the same check as without the direct path
  private readonly discoveredNames = new Set<string>();
  private busy = 0; // calls using Claude Code right now
  private idle?: ReturnType<typeof setTimeout>;
  private readonly clientSession = crypto.randomUUID();

  constructor(needs: Manifest[], private readonly openClaude: () => Promise<Client>, private readonly deps: DirectDeps = { login: readLogin, fetch },
    private readonly options: { fallback?: boolean; idleMs?: number } = {}) {
    this.use(needs);
  }

  /** Takes these connectors on; one already taken on is no change. */
  use(manifests: Manifest[]) {
    for (const m of manifests) {
      if (this.manifests.some(known => known.id === m.id)) continue;
      this.manifests.push(m);
      for (const t of m.tools) this.tools.set(t.sourceName, { id: typeof m.server?.id === "string" ? m.server.id : undefined, name: t.name, manifest: m });
    }
  }

  /** Why calls to these connectors (all taken on, by default) can't go direct now, or nothing when they can:
   * what a call checks first, without a request. */
  unusable(manifests = this.manifests): string | undefined {
    for (const m of manifests) { const why = this.connectorProblem(m); if (why) return why; }
    return this.loginProblem();
  }

  private connectorProblem(m: Manifest) {
    if (typeof m.server?.id !== "string") return `${m.connectorName} has no connector ID cached (run \`plugboard refresh\`)`;
    return this.refused.get(m.id);
  }

  /** The login, read again when there's none yet, it's near expiry, or the proxy refused it. */
  private loginProblem(): string | undefined {
    const stale = !this.login || this.login.accessToken === this.refusedToken
      || (this.login.expiresAt !== undefined && this.login.expiresAt - Date.now() <= REREAD_MS);
    if (stale) this.login = this.deps.login();
    const login = this.login;
    return !login ? "no claude.ai login found"
      : login.accessToken === this.refusedToken ? "the connector proxy refused the claude.ai login (401)"
      : login.expiresAt !== undefined && login.expiresAt - Date.now() <= EXPIRING_MS ? "the claude.ai login expires within a minute"
      : login.scopes !== undefined && !login.scopes.includes("user:mcp_servers") ? "the claude.ai login has no connector access (user:mcp_servers)"
      : undefined;
  }

  /** Claude Code, started once and kept while used; a start that failed is tried again by the next call. */
  private client(): Promise<Client> {
    if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
    return this.claude ??= this.openClaude().catch(error => { this.claude = undefined; throw error; });
  }

  /** A call through Claude Code, for this reason: refused under the transport direct. */
  private fallback(reason: string): Promise<Client> {
    this.notDirect = reason;
    if (this.options.fallback === false) return Promise.reject(markNotSent(fail("UNREACHABLE", `The transport is "direct" and ${reason}`,
      ["Set the transport to auto to let Claude Code make the call", "Run `plugboard doctor` for details"])));
    return this.client();
  }

  /** Waits for these connectors' discovery in Claude Code, once each: a call right after a start would find them pending. */
  private async discover(client: Client, names: string[]) {
    const missing = names.filter(name => !this.discoveredNames.has(name));
    if (!missing.length) return;
    this.discovered = await client.waitForServers(missing);
    for (const name of missing) this.discoveredNames.add(name);
  }

  /** Runs work that uses Claude Code; once none does, Claude Code closes after `idleMs`. */
  private async using<T>(work: () => Promise<T>): Promise<T> {
    this.busy++;
    try { return await work(); } finally {
      if (--this.busy === 0 && this.claude) {
        this.idle = setTimeout(() => void this.shut(), this.options.idleMs ?? 30_000);
        this.idle.unref?.(); // the timer never keeps a program from exiting
      }
    }
  }

  private async shut() {
    this.idle = undefined;
    const claude = this.claude;
    this.claude = undefined;
    this.discovered = [];
    this.discoveredNames.clear();
    await (await claude?.catch(() => undefined))?.close();
  }

  async waitForServers(names?: string[]): Promise<ConnectorServer[]> {
    const needs = names ? this.manifests.filter(m => names.includes(m.connectorName)) : this.manifests;
    const why = this.unusable(needs);
    if (why) return this.using(async () => {
      const client = await this.fallback(why);
      await this.discover(client, names ?? needs.map(m => m.connectorName));
      return this.discovered;
    });
    // The proxy has no status call: a connector that is no longer connected refuses the call, which falls back.
    return needs.map(m => ({ name: m.connectorName, status: "connected", config: m.server, tools: m.tools.map(t => ({ name: t.name })) }));
  }

  async request<T = Record<string, unknown>>(request: ControlRequest, options: { timeoutMs?: number } = {}): Promise<T> {
    if (request.subtype === "mcp_call") {
      const tool = this.tools.get(String(request.tool));
      let why = tool ? this.unusable([tool.manifest]) : `${String(request.tool)} isn't a tool of this session's connectors`;
      if (!why && tool?.id) {
        this.notDirect = undefined;
        const token = this.login!.accessToken;
        try { return await this.call({ id: tool.id, name: tool.name }, request.arguments, options.timeoutMs ?? 35_000) as T; } catch (error) {
          if (!(error instanceof Refused)) throw error;
          why = error.message;
          if (error.status === 401) this.refusedToken = token;
          else if (error.status) this.refused.set(tool.manifest.id, error.message);
        }
      }
      return this.using(async () => {
        let client: Client;
        try { // this call hasn't been sent anywhere yet: a Claude Code that can't start, or can't list it, says so
          client = await this.fallback(why!);
          if (tool) await this.discover(client, [tool.manifest.connectorName]);
        } catch (error) { throw markNotSent(error); }
        // As without the direct path: a connector Claude Code doesn't list as connected is refused before the call.
        if (tool) requireConnected(this.discovered, tool.manifest);
        return client.request<T>(request, options);
      });
    }
    // Nothing but the proxy was reached while Claude Code isn't running: the session's cost is zero by construction.
    // Each call's cost is checked right after it, so a Claude Code closed when idle was checked before it closed.
    if (request.subtype === "get_session_cost" && !this.claude)
      return { text: "Total cost: $0.0000 (connector proxy only)\nUsage: 0 input, 0 output, 0 cache read, 0 cache write" } as T;
    return this.using(async () => (await this.client()).request<T>(request, options));
  }

  async close() {
    if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
    await this.shut();
  }

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
    if ([400, 401, 403, 404].includes(res.status)) { await res.body?.cancel().catch(() => {}); throw new Refused(`the connector proxy refused the call (${res.status})`, res.status); }
    let text: string;
    try { text = await res.text(); } catch (error) {
      const e = error as Error & { code?: string; cause?: { code?: string } };
      throw mayHaveRun(e.name === "TimeoutError" || e.name === "AbortError" ? "the answer didn't finish in time" : `the answer was cut off (${e.code ?? e.cause?.code ?? e.name})`);
    }
    if (!res.ok) throw new Error(`connector proxy ${res.status}: ${text.slice(0, 200)}`);
    const message = parse(text, res.headers.get("content-type") ?? "");
    if (message?.error) throw new Error(String(message.error.message ?? "connector proxy error"));
    if (!message || typeof message.result !== "object" || message.result === null) throw new Error("connector proxy: no result in the answer");
    served.add(message.result);
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
