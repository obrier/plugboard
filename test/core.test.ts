// The core holds every safeguard itself, so neither the CLI nor the library can skip one. It takes the raw
// request (connector, tool, args) and resolves, validates and hashes it itself: there is nothing to forge.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit } from "../src/audit";
import { runBatch } from "../src/batch";
import type { Manifest } from "../src/cache";
import { callRead, callWrite, planCall, type Session } from "../src/core";
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
  test("a cost guard that fails after the send is audited", async () => {
    expect(await codeOf(callWrite(fakeSession({ cost: "Total cost: $0.0100" }).open, policy, send, req({ key: "k3" })))).toBe("COST_GUARD");
    expect(readAudit().map(e => e.status)).toEqual(["attempt", "ok", "cost-guard"]);
  });
});

test("batch checks connections once for the whole batch, then each line through the core", async () => {
  const s = fakeSession();
  const lines = ["a", "b", "c", "d"].map(q => JSON.stringify({ connector: "slack", tool: "slack_search", args: { query: q } })).join("\n");
  const outs: { ok: boolean }[] = [];
  const code = await runBatch(lines, { profile: "default", concurrency: 2, perConnector: 2, ordered: true, budgetMs: 10_000 }, out => outs.push(out),
    async () => ({ ...s.session, close: async () => {} }));
  expect(code).toBe(0);
  expect(outs.map(o => o.ok)).toEqual([true, true, true, true]);
  expect(s.statusChecks()).toBe(1);
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

describe("the audit lock", () => {
  const lockPath = () => join(root, "state", "audit.lock");
  const hash = () => planCall(policy, "executor", send).hash;
  const write = (key: string) => callWrite(fakeSession().open, policy, send, { profile: "executor", key, expectHash: hash(), deadlineMs: 1_000 });

  test("a lock left by a dead process is taken over at once", async () => {
    writeJson(lockPath(), { pid: 999_999_9 }); // no such process
    const started = Date.now();
    expect(await write("k-dead").then(() => "OK")).toBe("OK");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("waiting for a live holder doesn't block the event loop, and giving up is a coded error that says nothing was sent", async () => {
    writeJson(lockPath(), { pid: process.pid }); // held by a live process: this one
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    try {
      const error = await write("k-held").then(() => undefined, (e: { code?: string; message: string }) => e);
      expect(error?.code).toBe("TIMEOUT");
      expect(error?.message).toContain("not sent");
      expect(ticks).toBeGreaterThan(5);
    } finally { clearInterval(timer); }
  }, 15_000);

  test("a duplicate racing a write still in flight is told it's in progress, not to resolve it by hand", async () => {
    const s = fakeSession({ delayMs: 100 });
    const req = { profile: "executor", key: "pay-2", expectHash: hash(), deadlineMs: 1_000 };
    const results = await Promise.all([callWrite(s.open, policy, send, req), callWrite(s.open, policy, send, req)].map(p => p.then(() => "sent", (e: Error) => e.message)));
    expect(results.filter(r => r === "sent")).toHaveLength(1);
    expect(results.find(r => r !== "sent")).toContain("in progress");
  });
});
