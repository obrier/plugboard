// Live smoke test of the runtime seam: the bridge, a read, the cost guard and a schema capture, timed.
// Under Bun:  bun scripts/node-smoke.ts [connector] [tool] [json args]
// Under Node: bun build scripts/node-smoke.ts --target=node --outfile=dist/node-smoke.mjs && node dist/node-smoke.mjs …
// The capture writes to a temporary cache, never the real one. Read tools only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [connector = "context7", toolName = "resolve-library-id", json = '{"libraryName":"react","query":"hooks"}'] = process.argv.slice(2);
const cache = mkdtempSync(join(tmpdir(), "plugboard-smoke-"));
const realCache = process.env.PLUGBOARD_CACHE;
const { loadPolicy } = await import("../src/policy");
const { connect, costGuard } = await import("../src/claude");
const { loadManifest, refresh } = await import("../src/cache");
const { findTool } = await import("../src/cache");
const { invoke, prepare } = await import("../src/call");

const { runtime: { name: runtime } } = await import("../src/runtime");
const ms = (t: number) => `${Math.round(performance.now() - t)} ms`;
const policy = loadPolicy();
const manifest = loadManifest(connector);
if (!manifest) throw new Error(`No cached manifest for ${connector}: run plugboard refresh`);
const tool = findTool(manifest, toolName);
if (!tool) throw new Error(`${connector} has no tool ${toolName}`);
const p = prepare(policy, manifest, tool, JSON.parse(json), false);
if (p.cls !== "read") throw new Error(`${toolName} is not a read tool`);

console.log(runtime);
for (let i = 0; i < 3; i++) {
  let t = performance.now();
  const client = await connect(policy);
  const started = ms(t); t = performance.now();
  await client.waitForServers([manifest.connectorName]);
  const discovered = ms(t); t = performance.now();
  const raw = await invoke(client, p, 30_000);
  const called = ms(t); t = performance.now();
  await costGuard(client);
  const guarded = ms(t); t = performance.now();
  await client.close();
  console.log(`  start ${started}, discovery ${discovered}, call ${called} (${JSON.stringify(raw).length} bytes), cost guard ${guarded}, close ${ms(t)}`);
}

process.env.PLUGBOARD_CACHE = cache;
try {
  const t = performance.now();
  const result = await refresh(policy, [connector]);
  console.log(`  refresh ${connector} into a temp cache: ${result.tools} tools, updated ${result.updated.join(",") || "none"}, ${ms(t)}`);
} finally {
  if (realCache === undefined) delete process.env.PLUGBOARD_CACHE; else process.env.PLUGBOARD_CACHE = realCache;
  rmSync(cache, { recursive: true, force: true });
}
