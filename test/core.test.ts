// The core holds every safeguard itself, so neither the CLI nor the library can skip one. It takes the raw
// request (connector, tool, args) and resolves, validates and hashes it itself: there is nothing to forge.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimKey, keyState, readAudit, unresolvedKeys } from "../src/audit";
import type { Manifest } from "../src/cache";
import { callBatch, callRead, callWrite, planCall, type BatchLine, type BatchResult, type Session } from "../src/core";
import { fail, type PlugboardError } from "../src/errors";
import { parsePolicy } from "../src/policy";
import { writeJson } from "../src/platform";

const manifest: Manifest = { id: "slack", connectorName: "claude.ai Slack", capturedAt: "2026-11-04T00:00:00Z", tools: [
  { name: "slack_search", sourceName: "mcp__claude_ai_Slack__slack_search", inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "slack_send", sourceName: "mcp__claude_ai_Slack__slack_send", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  { name: "slack_delete", sourceName: "mcp__claude_ai_Slack__slack_delete", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
] };
const policy = parsePolicy(`[profiles.executor]\nmode = "write"\nallow = ["slack:*", "slack:slack_send"]\n[profiles.nosearch]\nmode = "read"\ndeny = ["slack:slack_search"]\n`, "/c/policy.toml");
const search = { connector: "slack", tool: "slack_search", args: { query: "x" } };
const send = { connector: "slack", tool: "slack_send", args: { text: "hi" } };

/** A session that answers every call with { ts }, records what was sent, counts opens and status checks. */
function fakeSession(o: { fail?: Error; cost?: string; delayMs?: number } = {}) {
  const sent: { tool: string; args: unknown }[] = [];
  let opened = 0, statusChecks = 0;
  const session: Session = {
    waitForServers: async () => { statusChecks++; return [{ name: "claude.ai Slack", status: "connected", tools: [] }]; },
    request: async (request: any) => {
      if (request.subtype === "get_session_cost") return { text: o.cost ?? "Total cost: $0.0000\nUsage: 0 input, 0 output, 0 cache read, 0 cache write" } as any;
      sent.push({ tool: request.tool, args: request.arguments });
      if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
      if (o.fail) throw o.fail;
      return { structuredContent: { ts: "1730.1" } } as any;
    },
  };
  return { open: async () => { opened++; return session; }, session, sent, opened: () => opened, statusChecks: () => statusChecks };
}

const saved: Record<string, string | undefined> = {};
let root = "";
beforeEach(() => {
  for (const k of ["PLUGBOARD_STATE", "PLUGBOARD_CACHE", "CLAUDECODE"]) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "plugboard-core-"));
  process.env.PLUGBOARD_STATE = join(root, "state");
  process.env.PLUGBOARD_CACHE = join(root, "cache");
  writeJson(join(root, "cache", "manifests", "slack.json"), manifest);
  writeJson(join(root, "cache", "index.json"), { format: 1, testedVersions: [], connectors: { slack: { name: "claude.ai Slack", status: "connected", tools: 3, read: 1, write: 2 } } });
  delete process.env.CLAUDECODE;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
const codeOf = async (promise: Promise<unknown>) => promise.then(() => "OK", (e: { code?: string }) => e.code);

describe("callRead", () => {
  test("a read that fails still has its cost checked: a model reached is COST_GUARD, not the read's own error", async () => {
    const s = fakeSession({ fail: new Error("upstream exploded"), cost: "Total cost: $0.0300\nUsage: 10 input, 5 output, 0 cache read, 0 cache write" });
    expect(await codeOf(callRead(s.open, policy, "default", search, 1_000))).toBe("COST_GUARD");
  });

  test("sends exactly the cached tool, with the args it validated; then the cost guard", async () => {
    const s = fakeSession();
    const out = await callRead(s.open, policy, "default", search, 1_000);
    expect(out.value).toEqual({ ts: "1730.1" });
    expect(s.sent).toEqual([{ tool: "mcp__claude_ai_Slack__slack_search", args: { query: "x" } }]);
  });
  test("refused before a session opens: a denied tool, a write tool, args the schema rejects, a tool not in the cache", async () => {
    const s = fakeSession();
    expect(await codeOf(callRead(s.open, policy, "nosearch", search, 1_000))).toBe("POLICY_DENIED");
    expect(await codeOf(callRead(s.open, policy, "executor", send, 1_000))).toBe("POLICY_DENIED");
    expect(await codeOf(callRead(s.open, policy, "default", { ...search, args: { query: 42, extra: true } }, 1_000))).toBe("VALIDATION_ERROR");
    expect(await codeOf(callRead(s.open, policy, "default", { connector: "slack", tool: "slack_nuke", args: {} }, 1_000))).toBe("NOT_FOUND");
    expect(s.opened()).toBe(0);
  });
  test("a session that wasn't zero-cost fails the call", async () => {
    expect(await codeOf(callRead(fakeSession({ cost: "Total cost: $0.0100" }).open, policy, "default", search, 1_000))).toBe("COST_GUARD");
  });
});

describe("callWrite", () => {
  const hash = () => planCall(policy, "executor", send).hash;
  const req = (o: Partial<{ key: string; expectHash: string; profile: string }> = {}) =>
    ({ profile: o.profile ?? "executor", key: o.key ?? "k1", expectHash: o.expectHash ?? hash(), deadlineMs: 1_000 });

  test("sends once, audited; the same key again replays without a session", async () => {
    const s = fakeSession();
    expect(await callWrite(s.open, policy, send, req())).toMatchObject({ replayed: false, key: "k1", ref: "1730.1" });
    expect(s.sent).toEqual([{ tool: "mcp__claude_ai_Slack__slack_send", args: { text: "hi" } }]);
    expect(readAudit().map(e => e.status)).toEqual(["attempt", "ok"]);
    const again = fakeSession();
    expect(await callWrite(again.open, policy, send, req())).toMatchObject({ replayed: true, key: "k1", ref: "1730.1" });
    expect(again.opened()).toBe(0);
  });
  test("the approval binds the args: other args under the approved hash are refused, unsent", async () => {
    const s = fakeSession();
    expect(await codeOf(callWrite(s.open, policy, { ...send, args: { text: "WIRE ALL THE MONEY" } }, req()))).toBe("POLICY_DENIED");
    expect(s.opened()).toBe(0);
    expect(readAudit()).toEqual([]);
  });
  test("refused before a session opens: a wrong hash, a read profile, no key, an agent session (first, even with no key)", async () => {
    const s = fakeSession();
    expect(await codeOf(callWrite(s.open, policy, send, req({ expectHash: "sha256:00" })))).toBe("POLICY_DENIED");
    expect(await codeOf(callWrite(s.open, policy, send, req({ profile: "default" })))).toBe("POLICY_DENIED");
    expect(await codeOf(callWrite(s.open, policy, send, req({ key: "" })))).toBe("VALIDATION_ERROR");
    process.env.CLAUDECODE = "1";
    expect(await codeOf(callWrite(s.open, policy, send, req({ key: "" })))).toBe("POLICY_DENIED");
    expect(s.opened()).toBe(0);
    expect(readAudit()).toEqual([]);
  });
  test("two writes under one key at once: one is sent, the other is refused", async () => {
    const s = fakeSession({ delayMs: 50 });
    const codes = await Promise.all([codeOf(callWrite(s.open, policy, send, req({ key: "pay-1" }))), codeOf(callWrite(s.open, policy, send, req({ key: "pay-1" })))]);
    expect(s.sent).toHaveLength(1);
    expect(codes.sort()).toEqual(["OK", "WRITE_OUTCOME_UNKNOWN"]);
  });
  test("a write the audit log can't record is never sent", async () => {
    writeFileSync(join(root, "blocked"), "");
    process.env.PLUGBOARD_STATE = join(root, "blocked"); // a file where the state folder goes
    const s = fakeSession();
    expect(await codeOf(callWrite(s.open, policy, send, req()))).not.toBe("OK");
    expect(s.sent).toEqual([]);
  });
  test("a timeout leaves the outcome unknown, and that key refuses until resolved", async () => {
    expect(await codeOf(callWrite(fakeSession({ fail: new Error("Timed out waiting for mcp_call") }).open, policy, send, req({ key: "k2" })))).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(await codeOf(callWrite(fakeSession().open, policy, send, req({ key: "k2" })))).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(readAudit().map(e => e.status)).toEqual(["attempt", "unknown"]);
  });
  test("a write that fails still has its cost checked, and the cost guard is audited", async () => {
    const s = fakeSession({ fail: new Error("upstream exploded"), cost: "Total cost: $0.0100" });
    const error = await callWrite(s.open, policy, send, req({ key: "k4" })).catch(e => e);
    expect(error.code).toBe("COST_GUARD");
    expect(error.message).toContain("upstream exploded");
    expect(readAudit().map(e => e.status)).toEqual(["attempt", "error", "cost-guard"]);
  });
  test("a cost guard that fails after the send is audited", async () => {
    expect(await codeOf(callWrite(fakeSession({ cost: "Total cost: $0.0100" }).open, policy, send, req({ key: "k3" })))).toBe("COST_GUARD");
    expect(readAudit().map(e => e.status)).toEqual(["attempt", "ok", "cost-guard"]);
  });
});

describe("callBatch: async iterables in and out", () => {
  const settings = { profile: "default", concurrency: 2, perConnector: 2, ordered: false };
  const line = (query: string, id?: string): BatchLine => ({ ...(id ? { id } : {}), connector: "slack", tool: "slack_search", args: { query } });
  /** A session whose answer to each query waits as the query says: "slow" 60 ms, "hang" until cancelled, "down" fails. */
  function scripted() {
    const sent: string[] = [];
    const cancelled: string[] = [];
    const session: Session = {
      waitForServers: async () => [{ name: "claude.ai Slack", status: "connected", tools: [] }],
      request: async (request: any, options?: { signal?: AbortSignal }) => {
        if (request.subtype === "get_session_cost") return { text: "Total cost: $0.0000\nUsage: 0 input, 0 output, 0 cache read, 0 cache write" } as any;
        const q = String(request.arguments.query);
        sent.push(q);
        if (q === "down") throw fail("UNREACHABLE", "Claude Code exited", ["Run `plugboard doctor` for details"]);
        if (q === "slow") await new Promise(r => setTimeout(r, 60));
        if (q === "hang") await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => { cancelled.push(q); reject(fail("TIMEOUT", "cancelled")); }));
        return { structuredContent: { q } } as any;
      },
    };
    return { open: () => async () => session, sent, cancelled };
  }
  const all = async <L extends BatchLine>(it: AsyncIterable<BatchResult<L>>) => { const out: BatchResult<L>[] = []; for await (const r of it) out.push(r); return out; };

  test("results come back while the producer is still feeding it", async () => {
    const s = scripted();
    let firstSeen!: () => void;
    const seen = new Promise<void>(r => (firstSeen = r));
    async function* producer() { yield line("a"); await seen; yield line("b"); } // b only once a's result is out
    const ids: unknown[] = [];
    for await (const r of callBatch(s.open, policy, producer(), settings)) { ids.push(r.id); firstSeen(); }
    expect(ids).toEqual([0, 1]);
  });

  test("completion order by default, input order with ordered; each line through the core", async () => {
    const s = scripted();
    const lines = [line("slow", "s"), line("fast", "f")];
    expect((await all(callBatch(s.open, policy, lines, settings))).map(r => r.id)).toEqual(["f", "s"]);
    const ordered = await all(callBatch(s.open, policy, lines, { ...settings, ordered: true }));
    expect(ordered.map(r => r.id)).toEqual(["s", "f"]);
    expect(ordered[0]).toMatchObject({ ok: true, value: { q: "slow" }, via: "claude-code" });
  });

  test("breaking out of the loop cancels the lines still running and closes the producer", async () => {
    const s = scripted();
    let closed = false;
    async function* producer() { try { yield line("hang"); yield line("fast"); yield line("never"); } finally { closed = true; } }
    for await (const r of callBatch(s.open, policy, producer(), { ...settings, concurrency: 2, perConnector: 2 })) { expect(r.ok).toBe(true); break; }
    expect(s.cancelled).toEqual(["hang"]);
    expect(s.sent).not.toContain("never");
    expect(closed).toBe(true);
  });

  test("UNREACHABLE fails the lines already taken, sent to no one, and ends the batch, even with an endless producer; hints kept", async () => {
    const s = scripted();
    let pulled = 0;
    function* endless() { yield line("down"); for (;;) { pulled++; yield line("more"); } }
    const out = await all(callBatch(s.open, policy, endless(), { ...settings, concurrency: 1, ordered: true }));
    expect(out[0]).toMatchObject({ ok: false, error: { code: "UNREACHABLE" } });
    expect(out.every(r => !r.ok && r.error.code === "UNREACHABLE" && r.error.hints.includes("Run `plugboard doctor` for details"))).toBe(true);
    expect(pulled).toBeLessThan(5);
    expect(s.sent).toEqual(["down"]);
  });

  test("a stop cancels the lines still running: they fail with it", async () => {
    const s = scripted();
    const out = await all(callBatch(s.open, policy, [line("hang", "h"), line("down", "d")], { ...settings, concurrency: 2, ordered: true }));
    expect(out.map(r => [r.id, !r.ok && r.error.code])).toEqual([["h", "UNREACHABLE"], ["d", "UNREACHABLE"]]);
    expect(s.cancelled).toEqual(["hang"]);
  });

  test("a producer that throws: the lines it gave finish and are delivered, then its error", async () => {
    const s = scripted();
    async function* broken() { yield line("slow", "a"); yield line("fast", "b"); throw new Error("producer broke"); }
    const seen: unknown[] = [];
    const error = await (async () => { for await (const r of callBatch(s.open, policy, broken(), settings)) { seen.push(r.id); await new Promise(r => setTimeout(r, 30)); } })().catch(e => e);
    expect((error as Error).message).toBe("producer broke");
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  test("ordered: results held for an earlier line count against the read-ahead", async () => {
    const s = scripted();
    let pulled = 0;
    function* endless() { yield line("slow"); for (;;) { pulled++; yield line("fast"); } }
    for await (const _ of callBatch(s.open, policy, endless(), { ...settings, concurrency: 2, perConnector: 2, ordered: true })) break;
    expect(pulled).toBeLessThan(10);
  });

  test("a line cancelled by its own signal is not retried", async () => {
    const s = scripted();
    const out = await all(callBatch(s.open, policy, [{ ...line("hang"), signal: AbortSignal.timeout(20) }], settings));
    expect(out[0]).toMatchObject({ ok: false, attempts: 1, retryable: false, error: { code: "TIMEOUT" } });
    expect(s.sent).toEqual(["hang"]);
  });

  test("a write tool, a bad line, a producer's own error and a profile that refuses are each one line's failure", async () => {
    const s = scripted();
    const items: (BatchLine | PlugboardError)[] = [
      { connector: "slack", tool: "slack_send", args: { text: "hi" } },
      { connector: 7 } as unknown as BatchLine,
      fail("VALIDATION_ERROR", "line 3 is not JSON"),
      { ...line("x"), profile: "nosearch" },
      line("ok", "fine"),
    ];
    const out = await all(callBatch(s.open, policy, items, { ...settings, ordered: true }));
    expect(out.map(r => r.id)).toEqual([0, 1, 2, 3, "fine"]);
    expect(out.map(r => r.ok ? "ok" : r.error.code)).toEqual(["POLICY_DENIED", "VALIDATION_ERROR", "VALIDATION_ERROR", "POLICY_DENIED", "ok"]);
    expect(s.sent).toEqual(["ok"]);
  });
});

describe("what is approved is what is sent", () => {
  // A tool with an untyped parameter: any JSON value passes its schema.
  const loose: Manifest = { ...manifest, tools: [...manifest.tools, { name: "slack_post", sourceName: "mcp__claude_ai_Slack__slack_post", inputSchema: { type: "object", properties: { blocks: {}, meta: {} } } }] };
  const post = (args: Record<string, unknown>) => ({ connector: "slack", tool: "slack_post", args });
  const exec = parsePolicy(`[profiles.executor]\nmode = "write"\nallow = ["slack:slack_post"]\n`, "/c/policy.toml");
  beforeEach(() => writeJson(join(root, "cache", "manifests", "slack.json"), loose));

  test("args are plain JSON before validation, hashing and sending: toJSON, getters and Dates can't change the wire", async () => {
    const withToJSON = Object.assign(Object.create({ toJSON: () => ({ evil: "WIRE" }) }), { a: 1 });
    let reads = 0;
    const getter = { get a() { return reads++ ? "EVIL" : "ok"; } };
    for (const args of [{ blocks: withToJSON }, { blocks: getter }, { meta: new Date("2030-01-01T00:00:00Z") }]) {
      const s = fakeSession();
      const hash = planCall(exec, "executor", post(args)).hash;
      const out = await callWrite(s.open, exec, post(args), { profile: "executor", key: `k-${Math.random()}`, expectHash: hash, deadlineMs: 1_000 }).then(() => "OK", (e: { code?: string }) => e.code);
      // Either the plain-JSON value is what's hashed and sent, or the call is refused; never a hash of one value and a send of another.
      if (out === "OK") expect(planCall(exec, "executor", post(JSON.parse(JSON.stringify(s.sent[0]!.args)))).hash).toBe(hash);
      else expect(s.sent).toEqual([]);
    }
  });

  test("the hash names the tool that is called, not only its name", () => {
    const before = planCall(exec, "executor", post({ meta: 1 })).hash;
    writeJson(join(root, "cache", "manifests", "slack.json"), { ...loose, tools: loose.tools.map(t => t.name === "slack_post" ? { ...t, sourceName: "mcp__claude_ai_Slack__slack_delete_channel" } : t) });
    expect(planCall(exec, "executor", post({ meta: 1 })).hash).not.toBe(before);
  });
});

describe("claiming a key: the audit log decides", () => {
  const hash = () => planCall(policy, "executor", send).hash;

  test("16 processes claiming one key at once: exactly one claims it, and every other attempt is withdrawn", async () => {
    const at = Date.now() + 1_500;
    const procs = Array.from({ length: 16 }, () => Bun.spawn(["bun", join(import.meta.dir, "fixtures/claim-key.ts"), String(at)], { env: process.env, stdout: "pipe" }));
    const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()));
    expect(outs.map(o => o.trim()).filter(o => o === "claimed")).toHaveLength(1);
    const entries = readAudit();
    // every process appends an attempt (the fixture claims with no pre-check); all but the winner's are withdrawn
    expect(entries.filter(e => e.status === "attempt").length - entries.filter(e => e.status === "withdrawn").length).toBe(1);
  }, 20_000);

  test("a duplicate racing a write still in flight is told it's in progress, not to resolve it by hand", async () => {
    const s = fakeSession({ delayMs: 100 });
    const req = { profile: "executor", key: "pay-2", expectHash: hash(), deadlineMs: 1_000 };
    const results = await Promise.all([callWrite(s.open, policy, send, req), callWrite(s.open, policy, send, req)].map(p => p.then(() => "sent", (e: Error) => e.message)));
    expect(results.filter(r => r === "sent")).toHaveLength(1);
    expect(results.find(r => r !== "sent")).toContain("in progress");
  });

  test("an attempt from long ago with no outcome is unknown, not in progress", async () => {
    writeJson(join(root, "state", "seed.json"), {}); // the state folder exists
    writeFileSync(join(root, "state", "audit.jsonl"), JSON.stringify({ ts: "2026-10-01T00:00:00Z", key: "old", status: "attempt", pid: process.pid, deadline_ms: 30_000 }) + "\n");
    const error = await callWrite(fakeSession().open, policy, send, { profile: "executor", key: "old", expectHash: hash(), deadlineMs: 1_000 }).then(() => undefined, (e: Error & { code?: string }) => e);
    expect(error?.code).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(error?.message).toContain("no known outcome");
  });
});

describe("claims that lose to a rival", () => {
  const hash = () => planCall(policy, "executor", send).hash;
  test("a duplicate racing a write that then fails does not resend: retrying after an error is a new call", async () => {
    const fail500 = fakeSession({ fail: new Error("upstream 500: internal error"), delayMs: 50 });
    const slow = fakeSession();
    const req = { profile: "executor", key: "dup", expectHash: hash(), deadlineMs: 1_000 };
    // B opens its session slowly, so A's attempt and error both land before B claims.
    const slowOpen = async () => { await new Promise(r => setTimeout(r, 150)); return slow.open(); };
    const results = await Promise.all([callWrite(fail500.open, policy, send, req), callWrite(slowOpen, policy, send, req)].map(p => p.then(() => "sent", (e: { code?: string }) => e.code)));
    expect(fail500.sent.length + slow.sent.length).toBe(1);
    expect(results).not.toContain("sent");
  });
  test("a losing attempt left by a crash after a send doesn't make the sent write read as unknown", async () => {
    writeJson(join(root, "state", "seed.json"), {});
    const lines = [
      { ts: new Date().toISOString(), key: "k", status: "attempt", nonce: "w", pid: 1, deadline_ms: 1_000 },
      { ts: new Date().toISOString(), key: "k", status: "ok", ref: "1730.1" },
      { ts: new Date().toISOString(), key: "k", status: "attempt", nonce: "l", pid: 2, deadline_ms: 1_000 }, // crashed before its withdrawal
    ];
    writeFileSync(join(root, "state", "audit.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    expect(await callWrite(fakeSession().open, policy, send, { profile: "executor", key: "k", expectHash: hash(), deadlineMs: 1_000 })).toMatchObject({ replayed: true, ref: "1730.1" });
  });
  const seed = (lines: object[]) => {
    writeJson(join(root, "state", "seed.json"), {});
    const ts = new Date().toISOString();
    writeFileSync(join(root, "state", "audit.jsonl"), lines.map(l => JSON.stringify({ ts, pid: 1, deadline_ms: 1_000, ...l })).join("\n") + "\n");
  };
  test("only an attempt that held a claim is a rival: a retry whose window holds just a withdrawn loser claims", () => {
    // Z claimed and failed; Y read the log before Z's attempt, so it lost to Z and withdrew; X read Z's error, not Y.
    seed([
      { key: "k", status: "attempt", nonce: "z", seen: 0 },
      { key: "k", status: "error", message: "upstream 500" },
      { key: "k", status: "attempt", nonce: "y", seen: 0 },
      { key: "k", status: "withdrawn", nonce: "y" },
    ]);
    expect(claimKey("k", { key: "k", status: "attempt" }, 2).claimed).toBe(true);
  });
  test("a loser that crashed before withdrawing, after a failed write, leaves the key failed, not unknown", () => {
    seed([
      { key: "k", status: "attempt", nonce: "a", seen: 0 },
      { key: "k", status: "error", message: "upstream 500" },
      { key: "k", status: "attempt", nonce: "l", seen: 0 }, // lost to a, crashed before its withdrawal
    ]);
    expect(keyState("k").state).toBe("error");
    expect(unresolvedKeys()).toHaveLength(0);
    expect(claimKey("k", { key: "k", status: "attempt" }).claimed).toBe(true);
  });
  test("an attempt without seen that was withdrawn sent nothing: the key keeps its outcome", () => {
    seed([
      { key: "k", status: "attempt", nonce: "a" },
      { key: "k", status: "error", message: "upstream 500" },
      { key: "k", status: "attempt", nonce: "l" },
      { key: "k", status: "withdrawn", nonce: "l" },
    ]);
    expect(keyState("k").state).toBe("error");
    expect(unresolvedKeys()).toHaveLength(0);
  });
  test("an attempt from a log without seen counts as a claim when the key allowed a send", () => {
    seed([{ key: "k", status: "attempt" }]);
    expect(keyState("k").state).toBe("unknown");
    expect(unresolvedKeys().map(e => e.key)).toEqual(["k"]);
  });
});

test("a direct write refused before sending, whose fallback can't start Claude Code, is recorded as not sent", async () => {
  const { DirectSession } = await import("../src/direct");
  const { fail } = await import("../src/errors");
  const direct = { ...manifest, server: { type: "claudeai-proxy", id: "mcpsrv_01slack" } };
  const refused = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  const session = new DirectSession([direct], async () => { throw fail("UNREACHABLE", "Couldn't start Claude Code"); },
    { login: () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }), fetch: refused });
  const req = { profile: "executor", key: "nostart", expectHash: planCall(policy, "executor", send).hash, deadlineMs: 1_000 };
  const error = await callWrite(async () => session, policy, send, req).catch(e => e);
  expect(error.code).toBe("UNREACHABLE");
  expect(readAudit().filter(e => e.key === "nostart").map(e => e.status)).toEqual(["attempt", "error"]);
  expect(keyState("nostart").state).toBe("error"); // a new call can retry it; nothing to resolve by hand
});

test("a session is opened for the connector the call names: a shared session takes it on then", async () => {
  const s = fakeSession();
  const opened: string[] = [];
  await callRead(async m => { opened.push(m.id); return s.session; }, policy, "default", search, 1_000);
  expect(opened).toEqual(["slack"]);
});

test("a write cancelled before it starts opens no session and records nothing", async () => {
  const s = fakeSession();
  const before = readAudit().length;
  const plan = planCall(policy, "executor", send);
  const error = await callWrite(s.open, policy, send, { profile: "executor", key: "k-cancel", expectHash: plan.hash, deadlineMs: 1_000, signal: AbortSignal.abort() }).catch(e => e);
  expect(error.code).toBe("TIMEOUT");
  expect(s.opened()).toBe(0);
  expect(readAudit().length).toBe(before);
});

test("a write cancelled after its claim, before the send, is recorded as an error: never unknown, never sent", async () => {
  const cancel = new AbortController();
  const s = fakeSession();
  const session: Session = {
    waitForServers: s.session.waitForServers,
    request: async (request: any, options?: { signal?: AbortSignal }) => {
      cancel.abort(); // between the claim and the send
      const { markNotSent, fail } = await import("../src/errors");
      if (options?.signal?.aborted) throw markNotSent(fail("TIMEOUT", "Cancelled before mcp_call was sent"));
      return s.session.request(request);
    },
  };
  const plan = planCall(policy, "executor", send);
  const error = await callWrite(async () => session, policy, send, { profile: "executor", key: "k-mid", expectHash: plan.hash, deadlineMs: 1_000, signal: cancel.signal }).catch(e => e);
  expect(error.code).toBe("TIMEOUT");
  expect(readAudit().filter(e => e.key === "k-mid").map(e => e.status)).toEqual(["attempt", "error"]);
  expect(s.sent).toHaveLength(0);
});
