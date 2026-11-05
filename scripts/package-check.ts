// The npm package as a user gets it, offline against the fake Claude Code (test/fixtures/fake-claude.ts):
// built and packed, installed into an empty project, its types checked from a TypeScript consumer, and a read
// made on Node through the transport claude-code (no login read, no network but npm's).
// Usage: bun scripts/package-check.ts          (CI runs it on Node 22)
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeConnectorCache } from "../test/fixtures/connectors";

const repo = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "plugboard-package-"));
const run = (cmd: string[], cwd: string, env: Record<string, string | undefined> = process.env) => {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${p.exitCode}:\n${p.stdout}\n${p.stderr}`);
  return p.stdout.toString();
};
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log(`  ${what}`); };

try {
  run(["bun", "run", "build:lib"], repo);
  const tarball = run(["npm", "pack", "--json", "--pack-destination", work], repo);
  const [packed] = JSON.parse(tarball) as { filename: string; files: { path: string }[] }[];
  const paths = packed!.files.map(f => f.path);
  check(paths.every(p => p.startsWith("dist/lib/") || ["package.json", "README.md", "LICENSE"].includes(p)), `the package holds the library only (${paths.length} files)`);

  const project = join(work, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run(["npm", "install", "--no-audit", "--no-fund", join(work, packed!.filename)], project);
  const installed = readdirSync(join(project, "node_modules")).filter(n => !n.startsWith("."));
  check(paths.includes("dist/lib/THIRD-PARTY-LICENSES.txt"), "it carries the licenses of the dependencies bundled in it");
  check(installed.length === 1 && installed[0] === "@obrier", `installing it fetches nothing else (node_modules: ${installed.join(", ")})`);

  // Its types, from a consumer with Node's types only.
  run(["npm", "install", "--no-audit", "--no-fund", "typescript@5", "@types/node@22"], project);
  writeFileSync(join(project, "consumer.ts"), `import { batch, call, close, createPlugboard, plan, write, PlugboardError, type BatchRead, type Read, type WritePlan, type Written } from "@obrier/plugboard";
const r: Read = await call({ connector: "gcal", tool: "list_calendars", signal: AbortSignal.timeout(1_000) });
const p: WritePlan = plan({ connector: "slack", tool: "send_message", args: { channel_id: "D1", message: "hi" }, profile: "executor" });
const w: Written = await write(JSON.parse(JSON.stringify(p)) as WritePlan, { key: "reply-42" });
if ("sent" in w) console.log(w.value, w.via, r.via);
for await (const b of batch([{ id: 1, connector: "gcal", tool: "list_calendars" }], { ordered: true })) { const one: BatchRead = b; if (!one.ok) console.log(one.error.code); }
const pb = createPlugboard({ transport: "direct", profile: "reader" });
try { await pb.call({ connector: "x", tool: "y" }); } catch (e) { if (e instanceof PlugboardError) console.log(e.code, e.hints, e.exitCode); }
await pb.close();
await close();
`);
  run(["npx", "tsc", "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "false", "consumer.ts"], project);
  check(true, "its types check from a TypeScript consumer (strict, nodenext, Node's types only)");

  // A read on Node, never closed: the program exits once it's done.
  const cache = join(work, "cache"), fake = join(work, "fake");
  mkdirSync(fake);
  writeConnectorCache(cache);
  writeFileSync(join(project, "read.mjs"), `import { createPlugboard } from "@obrier/plugboard";
const r = await createPlugboard({ transport: "claude-code" }).call({ connector: "slack", tool: "search-public", args: { query: "x" } });
console.log(JSON.stringify({ via: r.via, users: r.value.matches.map(m => m.user) }));
`);
  const env = { ...process.env, CLAUDECODE: undefined, PLUGBOARD_CACHE: cache, PLUGBOARD_STATE: join(work, "state"), PLUGBOARD_POLICY: join(work, "policy.toml"),
    PLUGBOARD_CLAUDE: join(repo, "test/fixtures/fake-claude.ts"), FAKE_DIR: fake };
  const started = Date.now();
  const out = run(["node", "read.mjs"], project, env);
  const ms = Date.now() - started;
  check(out.trim() === JSON.stringify({ via: "claude-code", users: ["jose", "ana"] }), `${run(["node", "--version"], project).trim()}: a read through the package, never closed, exits in ${ms} ms`);
  check(ms < 10_000, "without waiting for the idle close");
  // require(esm), Node 22.12 and later: the export needs a "default" condition, not only "import".
  writeFileSync(join(project, "require.cjs"), `const { createPlugboard } = require("@obrier/plugboard"); console.log(typeof createPlugboard);`);
  check(run(["node", "require.cjs"], project, env).trim() === "function", "require() loads it too");
} finally {
  rmSync(work, { recursive: true, force: true });
}
