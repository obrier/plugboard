// Long-lived signals on real Node, offline: a caller's signal that outlives its calls must not keep them alive.
//   bun build scripts/node-signals-check.ts --target=node --outfile=dist/node-signals-check.mjs && node --expose-gc dist/node-signals-check.mjs
// Node's AbortSignal.any keeps each combined signal while its sources live (and, on 22.12 and later, slows down as they
// accumulate), and AbortSignal.timeout keeps each call until its timer fires. Fake sessions and a fake proxy: no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../src/cache";
import { callBatch, type BatchLine, type Session } from "../src/core";
import { DirectSession, type Login } from "../src/direct";
import { writeJson } from "../src/platform";
import { parsePolicy } from "../src/policy";

assert.ok(!process.versions.bun, "run this with node, after bundling it with --target=node");
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run it with node --expose-gc");
const heapMb = () => { gc!(); gc!(); return process.memoryUsage().heapUsed / 1_048_576; };
const checks: string[] = [];
const check = async (name: string, run: () => Promise<void>) => { await run(); checks.push(name); };

const root = mkdtempSync(join(tmpdir(), "plugboard-signals-check-"));
process.env.PLUGBOARD_CACHE = join(root, "cache");
process.env.PLUGBOARD_STATE = join(root, "state");
const manifest: Manifest = {
  id: "slack", connectorName: "claude.ai Slack", capturedAt: "2026-11-05T00:00:00Z",
  server: { type: "claudeai-proxy", url: "https://slack.example/mcp", id: "mcpsrv_01slack" },
  tools: [{ name: "slack_search", sourceName: "mcp__claude_ai_Slack__slack_search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } }],
};
writeJson(join(root, "cache", "manifests", "slack.json"), manifest);
writeJson(join(root, "cache", "index.json"), { format: 1, testedVersions: [], connectors: { slack: { name: "claude.ai Slack", status: "connected", tools: 1, read: 1, write: 0 } } });
const policy = parsePolicy("", join(root, "policy.toml"));

try {
  await check("a long batch whose lines share one caller signal stays flat in memory and time", async () => {
    const session: Session = {
      waitForServers: async () => [{ name: "claude.ai Slack", status: "connected", tools: [] }],
      request: async (request: any) => request.subtype === "get_session_cost"
        ? { text: "Total cost: $0.0000\nUsage: 0 input, 0 output, 0 cache read, 0 cache write" } as any
        : { structuredContent: { ok: true } } as any,
    };
    const app = new AbortController(); // the program's own signal, alive for as long as the program
    const rounds: { mb: number; ms: number }[] = [];
    const before = heapMb();
    async function* lines(): AsyncGenerator<BatchLine> {
      for (let round = 0; round < 4; round++) {
        const started = performance.now();
        for (let i = 0; i < 15_000; i++) yield { connector: "slack", tool: "slack_search", args: { query: "x" }, signal: app.signal };
        rounds.push({ mb: heapMb() - before, ms: performance.now() - started });
      }
    }
    let ok = 0;
    for await (const r of callBatch(() => async () => session, policy, lines(), { profile: "default", concurrency: 4, perConnector: 4, ordered: false })) if (r.ok) ok++;
    assert.equal(ok, 60_000);
    const growth = heapMb() - before;
    const [first, last] = [rounds[0]!, rounds.at(-1)!];
    console.log(`  batch: heap +${growth.toFixed(1)} MB, rounds ${rounds.map(r => `${Math.round(r.ms)} ms`).join(", ")}`);
    assert.ok(growth < 8, `the batch kept ${growth.toFixed(1)} MB after 60,000 lines`);
    assert.ok(last.ms < first.ms * 3 + 200, `the last 15,000 lines took ${Math.round(last.ms)} ms, the first ${Math.round(first.ms)} ms`);
  });

  await check("direct calls that share one caller signal are released when they end, not when their timeout would fire", async () => {
    const login: Login = { accessToken: "token", expiresAt: Date.now() + 3_600_000, scopes: ["user:mcp_servers"] };
    const fetch = (async (_url: string, init: RequestInit) =>
      Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: { content: [] } })) as unknown as typeof globalThis.fetch;
    const s = new DirectSession([manifest], (async () => { throw new Error("Claude Code is never started here"); }) as never, { login: () => login, fetch });
    const app = new AbortController();
    const call = { subtype: "mcp_call", tool: "mcp__claude_ai_Slack__slack_search", arguments: { query: "x" } } as const;
    await s.request(call, { signal: app.signal }); // warm up
    const before = heapMb();
    for (let i = 0; i < 30_000; i++) await s.request(call, { timeoutMs: 600_000, signal: app.signal });
    const growth = heapMb() - before;
    console.log(`  direct: heap +${growth.toFixed(1)} MB after 30,000 calls`);
    assert.ok(growth < 8, `30,000 finished calls kept ${growth.toFixed(1)} MB`);
    await s.close();
  });
} finally { rmSync(root, { recursive: true, force: true }); }

console.log(`node ${process.versions.node}: ${checks.length} checks pass\n${checks.map(c => `  ${c}`).join("\n")}`);
