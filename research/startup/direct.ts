// Calls a claude.ai connector through Anthropic's MCP proxy directly, without Claude Code.
//
// Reads Claude Code's claude.ai OAuth login from the macOS keychain (service "Claude Code-credentials",
// account $USER, the same item Claude Code reads) in memory only. Never prints, logs or writes the
// token, any request or response header value, or the keychain output.
//
// Usage: bun direct.ts <mcpsrv id> <tool> [args json] [--init] [--ua <user agent>]
//   --bad-token  send a made-up token instead (to see the 401 the fallback keys on)
//   --init  send MCP initialize first (and notifications/initialized) instead of a single tools/call
// Prints one JSON line: timings, HTTP statuses, the proxy's error code header name if any, and the
// result's shape (isError, number of content blocks, text length). Exit code 0 only on a tool result.
const argv = Bun.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--ua"));
const [id, tool, rawArgs = "{}"] = positional;
const ua = opt("ua") ?? "plugboard-research/0.1";
const PROXY = `https://mcp-proxy.anthropic.com/v1/mcp/${id}`;
const PROTOCOL = "2025-11-25";

const t0 = performance.now();
const out: Record<string, unknown> = { id, tool };
const ms = () => Math.round(performance.now() - t0);

function readLogin(): { accessToken: string; expiresAt?: number; scopes?: string[] } | undefined {
  const user = process.env.USER ?? "";
  const p = Bun.spawnSync(["security", "find-generic-password", "-a", user, "-w", "-s", "Claude Code-credentials"], { stderr: "ignore" });
  if (p.exitCode !== 0) { out.keychainExit = p.exitCode; return undefined; }
  try { return JSON.parse(p.stdout.toString().trim()).claudeAiOauth; } catch { out.keychain = "unparsable"; return undefined; }
}

const login = readLogin();
out.keychainMs = ms();
if (!login?.accessToken) { out.fallback = "no_login"; console.log(JSON.stringify(out)); process.exit(2); }
out.expiresInS = login.expiresAt ? Math.round((login.expiresAt - Date.now()) / 1000) : null;
out.hasScope = login.scopes?.includes("user:mcp_servers") ?? null;
if (login.expiresAt && login.expiresAt - Date.now() < 60_000) { out.fallback = "token_expiring"; console.log(JSON.stringify(out)); process.exit(2); }

const sessionId = crypto.randomUUID();
let mcpSession: string | undefined;
async function rpc(body: object, notification = false) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${flag("bad-token") ? "not-a-token" : login!.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": ua,
    "Accept-Encoding": "identity",
    "X-Mcp-Client-Session-Id": sessionId,
    "MCP-Protocol-Version": PROTOCOL,
  };
  if (mcpSession) headers["Mcp-Session-Id"] = mcpSession;
  const res = await fetch(PROXY, { method: "POST", headers, body: JSON.stringify(body) });
  mcpSession = res.headers.get("mcp-session-id") ?? mcpSession;
  const errorCode = res.headers.get("x-mcp-error-code");
  const type = res.headers.get("content-type") ?? "";
  const text = notification ? (await res.text(), "") : await res.text();
  let message: any;
  if (type.includes("text/event-stream")) {
    for (const line of text.split("\n")) if (line.startsWith("data: ")) { try { const m = JSON.parse(line.slice(6)); if ("result" in m || "error" in m) message = m; } catch {} }
  } else if (text) { try { message = JSON.parse(text); } catch {} }
  return { status: res.status, errorCode: errorCode ? "present" : undefined, type: type.split(";")[0], message, bodyLength: text.length };
}

const steps: unknown[] = [];
try {
  if (flag("init")) {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "plugboard-research", version: "0.1" } } });
    steps.push({ step: "initialize", status: init.status, ms: ms(), session: mcpSession ? "issued" : "none",
      protocolVersion: init.message?.result?.protocolVersion, error: init.message?.error?.message });
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
    steps.push({ step: "initialized", ms: ms() });
  }
  const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(rawArgs) } });
  const r = call.message?.result;
  steps.push({ step: "tools/call", status: call.status, ms: ms(), type: call.type, errorCode: call.errorCode,
    rpcError: call.message?.error ? { code: call.message.error.code, message: String(call.message.error.message).slice(0, 160) } : undefined,
    isError: r?.isError ?? (r ? false : undefined), blocks: Array.isArray(r?.content) ? r.content.length : undefined,
    textLength: Array.isArray(r?.content) ? r.content.map((c: any) => c.text?.length ?? 0).reduce((a: number, b: number) => a + b, 0) : undefined,
    bodyLength: r ? undefined : call.bodyLength });
  out.ok = call.status === 200 && r !== undefined && !r.isError;
} catch (e) {
  out.networkError = (e as Error).name;
}
out.steps = steps;
out.total = ms();
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
