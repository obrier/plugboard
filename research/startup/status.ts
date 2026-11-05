// Prints the mcp_status entry of one server once it settles, without its tools list.
// Usage: bun status.ts [server name] [extra claude args...]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../src/bridge/capture";
import { findClaude } from "../../src/platform";
const [server = "claude.ai Google Calendar", ...extra] = Bun.argv.slice(2);
const cwd = await mkdtemp(join(tmpdir(), "claude-connectors-"));
const proc = Bun.spawn([findClaude(), "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
  "--no-session-persistence", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--tools", "",
  "--permission-mode", "dontAsk", "--no-chrome", ...extra], { cwd, env: childEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const waiters = new Map<string, (r: any) => void>();
(async () => { let buf = ""; const dec = new TextDecoder();
  for await (const c of proc.stdout) { buf += dec.decode(c, { stream: true }); let nl;
    while ((nl = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); try { const m = JSON.parse(l);
      if (m.type === "control_response") waiters.get(m.response?.request_id)?.(m.response); } catch {} } } })();
const request = (r: object) => new Promise<any>(res => { const id = crypto.randomUUID(); waiters.set(id, x => res(x.response ?? x));
  proc.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: r }) + "\n"); proc.stdin.flush(); });
const init = await request({ subtype: "initialize" });
for (let i = 0; i < 200; i++) {
  const s = (await request({ subtype: "mcp_status" })).mcpServers?.find((x: any) => x.name === server);
  if (s && s.status !== "pending") { const { tools, ...rest } = s; console.log(JSON.stringify({ ...rest, toolCount: tools?.length, initCapabilities: init.capabilities?.length ?? Object.keys(init).join(",") }, null, 1)); break; }
  await Bun.sleep(50);
}
proc.kill(); await proc.exited; await rm(cwd, { recursive: true, force: true });
