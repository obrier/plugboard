// The bridge on real Node, offline: CI bundles this for Node and runs it with `node`, from the repo root.
//   bun build scripts/node-bridge-check.ts --target=node --outfile=dist/node-bridge-check.mjs && node dist/node-bridge-check.mjs
// It drives test/fixtures/claude-control.ts (a fake Claude Code), so no account or network is used.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeConnectors } from "../src/bridge/client";
import { connect } from "../src/claude";
import { parsePolicy } from "../src/policy";
import { runtime } from "../src/runtime";

assert.ok(!process.versions.bun, "run this with node, after bundling it with --target=node");
assert.equal(runtime.name, `node ${process.versions.node}`);
const fixture = join(process.cwd(), "test/fixtures/claude-control.ts");
const checks: string[] = [];
const check = async (name: string, run: () => Promise<void> | void) => { await run(); checks.push(name); };

await check("connect, discovery, a call, schema capture, a request timeout, close, then the closed error", async () => {
  const client = await ClaudeConnectors.connect({ claudePath: fixture, requestTimeoutMs: 2_000 });
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["mcp__claude_ai_Mail__search", "mcp__claude_ai_Drive__search"]);
    const result = await client.callTool("mcp__claude_ai_Drive__search", { value: "résumé" });
    assert.deepEqual(result.structuredContent, { tool: "mcp__claude_ai_Drive__search", value: "résumé" });
    const withSchemas = await client.listTools({ includeSchemas: true }); // schema capture: Node's loopback server and a second spawn
    assert.deepEqual(withSchemas.map(tool => typeof tool.inputSchema), ["object", "object"]);
    await assert.rejects(client.request({ subtype: "mcp_call", tool: "mcp__claude_ai_Drive__search", arguments: { delay: 5_000 } }, { timeoutMs: 200 }), /Timed out waiting for mcp_call/);
  } finally { await client.close(); }
  await assert.rejects(client.request({ subtype: "get_session_cost" }));
});

await check("a Claude Code it can't start is a permission problem (exit 10, the sandbox hint)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plugboard-node-check-"));
  try {
    const blocked = join(dir, "claude");
    writeFileSync(blocked, "#!/bin/sh\n");
    chmodSync(blocked, 0o644);
    const policy = parsePolicy("", join(dir, "policy.toml"));
    const error = await connect({ ...policy, claudePath: blocked }).then(() => undefined, (e: unknown) => e as Error & { code?: string; suggestions?: string[] });
    assert.equal(error?.code, "BRIDGE_BROKEN");
    assert.match(error!.message, /Couldn't start Claude Code .*EACCES/);
    assert.match(error!.suggestions!.join(" "), /sandbox/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("policy TOML parses the same as under Bun", () => {
  const policy = parsePolicy(`[profiles]\ngather = {\n  mode = "read",\n  allow = ["slack:*"],\n}\n`, "/c/policy.toml");
  assert.deepEqual(Object.keys(policy.profiles).sort(), ["default", "gather"]);
});

console.log(`${runtime.name}: ${checks.length} checks pass\n${checks.map(c => `  ${c}`).join("\n")}`);
