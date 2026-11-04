// Opt-in live smoke test: plugboard refresh, then LIVE=1 bun test test/live.test.ts.
// It uses only what this machine has: the cached connectors, the policy and its default profile.
// Read-only by construction: it calls only tools the policy classifies as read.
import { expect, test } from "bun:test";
import { loadIndex, loadManifest } from "../src/cache";
import { classify, loadPolicy } from "../src/policy";

const CLI = `${import.meta.dir}/../src/cli.ts`;
const isJson = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };

test.skipIf(!process.env.LIVE)("live reads succeed at zero cost, and doctor passes", async () => {
  const policy = loadPolicy();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const run = async (args: string[]) => {
    const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  };

  const connected = Object.entries(loadIndex()?.connectors ?? {}).filter(([, entry]) => entry.status === "connected").map(([id]) => id);
  if (!connected.length) throw new Error("No connected connector in the cache: run `plugboard refresh` first");

  // Per connector, the read tools that need no arguments. Some still fail upstream when called bare,
  // so a connector passes when one of them succeeds; a connector with none is skipped.
  const failures: string[] = [];
  let tried = 0;
  for (const id of connected) {
    const tools = (loadManifest(id)?.tools ?? [])
      .filter(tool => classify(policy, id, tool) === "read" && !(tool.inputSchema.required ?? []).length);
    if (!tools.length) continue;
    tried++;
    const errors: string[] = [];
    for (const tool of tools) {
      const result = await run([id, tool.name, "--out", "json"]);
      if (result.code === 0 && isJson(result.out)) { errors.length = 0; break; } // exit 0 includes the cost guard: $0, 0 tokens
      errors.push(`${tool.name}: exit ${result.code} ${result.err.trim().split("\n")[0] ?? ""}`);
    }
    if (errors.length) failures.push(`${id}: ${errors.join("; ")}`);
  }
  expect(tried).toBeGreaterThan(0);
  expect(failures).toEqual([]);

  const doctor = await run(["doctor"]); // the default profile, or PLUGBOARD_PROFILE
  expect(doctor.code).toBe(0);
}, 300_000);
