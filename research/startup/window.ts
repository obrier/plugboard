// Runs Claude Code as plugboard does with --debug-file, and prints every debug line's offset
// from spawn with its first 140 characters (URLs elided; lines naming a token or Bearer dropped).
// Usage: bun window.ts <debug dir>
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../src/bridge/capture";
import { findClaude } from "../../src/platform";
const dir = Bun.argv[2]!;
const cwd = await mkdtemp(join(tmpdir(), "claude-connectors-"));
const file = join(dir, `window-${Date.now()}.log`);
const wall0 = Date.now();
const proc = Bun.spawn([findClaude(), "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
  "--no-session-persistence", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--tools", "",
  "--permission-mode", "dontAsk", "--no-chrome", "--debug-file", file], { cwd, env: childEnv(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const send = (request: object) => { proc.stdin.write(JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request }) + "\n"); proc.stdin.flush(); };
send({ subtype: "initialize" });
await Bun.sleep(400);
for (let i = 0; i < 40; i++) { send({ subtype: "mcp_status" }); await Bun.sleep(50); }
proc.kill("SIGTERM"); await proc.exited; await rm(cwd, { recursive: true, force: true });
for (const line of (await readFile(file, "utf8")).split("\n")) {
  const ts = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)/)?.[1];
  if (!ts || /token|bearer|authorization/i.test(line)) continue;
  console.log(`+${Date.parse(ts) - wall0}ms ${line.slice(ts.length).replace(/https?:\/\/\S+/g, "<url>").slice(0, 140).trim()}`);
}
await rm(file, { force: true });
