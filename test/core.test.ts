// The core holds every safeguard itself, so neither the CLI nor the library can skip one:
// the policy decides before a session opens, and a write is refused, replayed or audited in the core.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit } from "../src/audit";
import type { Manifest } from "../src/cache";
import { prepare } from "../src/call";
import { callRead, callWrite, type Session } from "../src/core";
import { parsePolicy } from "../src/policy";

const manifest: Manifest = { id: "slack", connectorName: "claude.ai Slack", capturedAt: "2026-11-04T00:00:00Z", tools: [
  { name: "slack_search", sourceName: "mcp__claude_ai_Slack__slack_search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "slack_send", sourceName: "mcp__claude_ai_Slack__slack_send", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
] };
const policy = parsePolicy(`[profiles.executor]\nmode = "write"\nallow = ["slack:*", "slack:slack_send"]\n[profiles.nosearch]\nmode = "read"\ndeny = ["slack:slack_search"]\n`, "/c/policy.toml");
const [search, send] = manifest.tools as [Manifest["tools"][number], Manifest["tools"][number]];

/** A session that answers every call with { ts }, counts how often it was opened, and can fail. */
function fakeSession(o: { fail?: Error; cost?: string } = {}) {
  const calls: string[] = [];
  let opened = 0;
  const session: Session = {
    waitForServers: async () => [{ name: "claude.ai Slack", status: "connected", tools: [] }],
    request: async (request: any) => {
      if (request.subtype === "get_session_cost") return { text: o.cost ?? "Total cost: $0.0000\nUsage: 0 input, 0 output, 0 cache read, 0 cache write" } as any;
      calls.push(request.tool);
      if (o.fail) throw o.fail;
      return { structuredContent: { ts: "1730.1" } } as any;
    },
  };
  return { open: async () => { opened++; return session; }, calls, opened: () => opened };
}

let state: string | undefined;
let saved: string | undefined;
let claudecode: string | undefined;
beforeEach(() => {
  saved = process.env.PLUGBOARD_STATE; claudecode = process.env.CLAUDECODE;
  state = process.env.PLUGBOARD_STATE = mkdtempSync(join(tmpdir(), "plugboard-core-"));
  delete process.env.CLAUDECODE;
});
afterEach(() => {
  rmSync(state!, { recursive: true, force: true });
  if (saved === undefined) delete process.env.PLUGBOARD_STATE; else process.env.PLUGBOARD_STATE = saved;
  if (claudecode === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = claudecode;
});
const codeOf = async (promise: Promise<unknown>) => promise.then(() => "OK", (e: { code?: string }) => e.code);

describe("callRead", () => {
  test("a read the profile allows: one call, then the cost guard", async () => {
    const s = fakeSession();
    const out = await callRead(s.open, policy, "default", prepare(policy, manifest, search, { query: "x" }, false), 1_000);
    expect(out.value).toEqual({ ts: "1730.1" });
    expect(s.calls).toEqual(["mcp__claude_ai_Slack__slack_search"]);
  });
  test("a profile that denies the tool refuses before a session opens", async () => {
    const s = fakeSession();
    expect(await codeOf(callRead(s.open, policy, "nosearch", prepare(policy, manifest, search, {}, false), 1_000))).toBe("POLICY_DENIED");
    expect(s.opened()).toBe(0);
  });
  test("a write tool can't go through the read path", async () => {
    const s = fakeSession();
    expect(await codeOf(callRead(s.open, policy, "executor", prepare(policy, manifest, send, { text: "hi" }, false), 1_000))).toBe("POLICY_DENIED");
    expect(s.opened()).toBe(0);
  });
  test("a session that wasn't zero-cost fails the call", async () => {
    const s = fakeSession({ cost: "Total cost: $0.0100" });
    expect(await codeOf(callRead(s.open, policy, "default", prepare(policy, manifest, search, {}, false), 1_000))).toBe("COST_GUARD");
  });
});

describe("callWrite", () => {
  const p = () => prepare(policy, manifest, send, { text: "hi" }, true);
  const req = (o: Partial<{ key: string; expectHash: string; profile: string }> = {}) =>
    ({ profile: o.profile ?? "executor", key: o.key ?? "k1", expectHash: o.expectHash ?? p().hash, deadlineMs: 1_000 });

  test("sends once, audited; the same key again replays without a session", async () => {
    const s = fakeSession();
    const first = await callWrite(s.open, policy, p(), req());
    expect(first).toMatchObject({ replayed: false, key: "k1", ref: "1730.1" });
    expect(readAudit().map(e => e.status)).toEqual(["attempt", "ok"]);
    const again = fakeSession();
    expect(await callWrite(again.open, policy, p(), req())).toMatchObject({ replayed: true, key: "k1", ref: "1730.1" });
    expect(again.opened()).toBe(0);
  });
  test("a payload that isn't the approved one, a read profile, an agent session, or no key: refused before a session opens", async () => {
    const s = fakeSession();
    expect(await codeOf(callWrite(s.open, policy, p(), req({ expectHash: "sha256:00" })))).toBe("POLICY_DENIED");
    expect(await codeOf(callWrite(s.open, policy, p(), req({ profile: "default" })))).toBe("POLICY_DENIED");
    expect(await codeOf(callWrite(s.open, policy, p(), req({ key: "" })))).toBe("VALIDATION_ERROR");
    process.env.CLAUDECODE = "1";
    expect(await codeOf(callWrite(s.open, policy, p(), req()))).toBe("POLICY_DENIED");
    expect(s.opened()).toBe(0);
    expect(readAudit()).toEqual([]);
  });
  test("a timeout leaves the outcome unknown, and that key refuses until resolved", async () => {
    const s = fakeSession({ fail: new Error("Timed out waiting for mcp_call") });
    expect(await codeOf(callWrite(s.open, policy, p(), req({ key: "k2" })))).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(await codeOf(callWrite(fakeSession().open, policy, p(), req({ key: "k2" })))).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(readAudit().map(e => e.status)).toEqual(["attempt", "unknown"]);
  });
});
