// Times one plugboard-style call through Claude Code's control protocol, phase by phase.
// Spawns Claude Code with plugboard's own arguments (src/bridge/client.ts), polls mcp_status
// every 50 ms until the target server leaves `pending`, calls one read tool, then checks that
// get_session_cost is still $0 with zero usage.
//
// Usage: bun probe.ts [--debug <dir>] [--warm <n>] [--server <name>] [--tool <qualified name>]
//   --debug <dir>  also pass --debug-file and print the timestamps of the connector legs
//   --warm <n>     after the first call, call the tool n more times in the same process
//   --config <file> start Claude Code with only the servers in this --mcp-config file
//   --args <json>  the tool arguments (default {})
//   --no-wait      send mcp_call right after initialize, without polling mcp_status
// Prints one JSON line per run.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../src/bridge/capture";
import { findClaude } from "../../src/platform";

const argv = Bun.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const debugDir = opt("debug");
const warm = Number(opt("warm", "0"));
const server = opt("server", "claude.ai Google Calendar")!;
const tool = opt("tool", "mcp__claude_ai_Google_Calendar__list_calendars")!;
const noWait = argv.includes("--no-wait");
const toolArgs = JSON.parse(opt("args", "{}")!);
const mcpConfig = opt("config") && (await import("node:path")).resolve(opt("config")!);
setTimeout(() => { console.log(JSON.stringify({ error: "probe timed out after 30 s" })); process.exit(1); }, 30_000).unref();

const cwd = await mkdtemp(join(tmpdir(), "claude-connectors-"));
const debugFile = debugDir ? join(debugDir, `debug-${Date.now()}.log`) : undefined;
const args = [
  findClaude(), "--print", "--verbose",
  "--input-format", "stream-json", "--output-format", "stream-json",
  "--no-session-persistence", "--setting-sources", "",
  "--settings", '{"disableAllHooks":true}', "--tools", "",
  "--permission-mode", "dontAsk", "--no-chrome",
  ...(debugFile ? ["--debug-file", debugFile] : []),
  ...(mcpConfig ? ["--strict-mcp-config", "--mcp-config", mcpConfig] : []),
];

const t0 = performance.now();
const wall0 = Date.now();
const proc = Bun.spawn(args, { cwd, env: childEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const waiters = new Map<string, (r: any) => void>();
(async () => {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m: any; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "control_request") {
        proc.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "no" } }) + "\n");
      } else if (m.type === "control_response") {
        const w = waiters.get(m.response?.request_id); if (w) { waiters.delete(m.response.request_id); w(m.response); }
      }
    }
  }
})();
function request(req: Record<string, unknown>): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    waiters.set(id, r => r.subtype === "success" ? resolve(r.response ?? {}) : reject(new Error(String(r.error))));
    proc.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: req }) + "\n");
    proc.stdin.flush();
  });
}
const ms = (t: number) => Math.round(t - t0);

const result: Record<string, unknown> = {};
try {
  await request({ subtype: "initialize" });
  result.initialize = ms(performance.now());
  let polls = 0;
  for (; !noWait;) {
    polls++;
    const { mcpServers } = await request({ subtype: "mcp_status" });
    const s = mcpServers.find((x: any) => x.name === server);
    if (s && s.status !== "pending") { result.status = s.status; break; }
    await Bun.sleep(50);
  }
  result.discovered = ms(performance.now());
  result.polls = polls;
  const callStart = performance.now();
  const r = await request({ subtype: "mcp_call", tool, arguments: toolArgs });
  result.call = Math.round(performance.now() - callStart);
  result.isError = r.isError ?? false;
  if (r.isError) result.errorText = JSON.stringify(r.content).slice(0, 200);
  result.total = ms(performance.now());
  const warmCalls: number[] = [];
  for (let i = 0; i < warm; i++) {
    const s = performance.now();
    await request({ subtype: "mcp_call", tool, arguments: toolArgs });
    warmCalls.push(Math.round(performance.now() - s));
  }
  if (warm) result.warmCalls = warmCalls;
  const { text } = await request({ subtype: "get_session_cost" });
  result.zeroCost = /\$0\.0000\b/.test(text) && /Usage:\s+0 input, 0 output, 0 cache read, 0 cache write/.test(text);
} catch (e) {
  result.error = (e as Error).message;
} finally {
  proc.kill("SIGTERM");
  await proc.exited;
  await rm(cwd, { recursive: true, force: true });
}

if (debugFile) {
  // Only the connector-loading lines, as offsets from spawn; nothing else of the log is printed.
  const patterns = [
    /\[claudeai-mcp\] Fetching from/, /\[claudeai-mcp\] Fetched \d+ servers/,
    new RegExp(`MCP server "${server.replace(/[.]/g, "\\.")}"`),
    /Starting MCP|MCP servers? (loaded|connect)/i, /cached_init_response|cached_discover_response/,
  ];
  const legs: string[] = [];
  for (const line of (await readFile(debugFile, "utf8")).split("\n")) {
    const ts = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)/)?.[1];
    if (!ts || !patterns.some(p => p.test(line))) continue;
    legs.push(`+${Date.parse(ts) - wall0}ms ${line.slice(ts.length).replace(/https?:\/\/\S+/g, "<url>").slice(0, 160).trim()}`);
  }
  result.legs = legs;
  await rm(debugFile, { force: true });
}
console.log(JSON.stringify(result));
