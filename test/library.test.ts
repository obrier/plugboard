// The library's API (docs/design/library.md), against test/fixtures/fake-claude.ts through the transport
// claude-code: no network, no account, no login read. Every "write" lands in the fake's calls.jsonl.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlugboard, PlugboardError, type Plugboard } from "../src/index";
import { writeConnectorCache } from "./fixtures/connectors";

const root = mkdtempSync(join(tmpdir(), "plugboard-library-"));
const fake = join(root, "fake");
const POLICY = `transport = "claude-code"
[profiles.executor]
mode = "write"
allow = ["slack:slack_send_message", "slack:slack_create_note"]
`;
const ENV = {
  PLUGBOARD_CACHE: join(root, "cache"), PLUGBOARD_STATE: join(root, "state"), PLUGBOARD_POLICY: join(root, "policy.toml"),
  PLUGBOARD_TRANSFORMS: join(root, "transforms.toml"), PLUGBOARD_CLAUDE: join(import.meta.dir, "fixtures/fake-claude.ts"), FAKE_DIR: fake,
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  for (const k of ["CLAUDECODE", "PLUGBOARD_PROFILE", "PLUGBOARD_TRANSPORT", "PLUGBOARD_DIRECT"]) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});
let pb: Plugboard;
beforeEach(() => {
  for (const dir of ["cache", "state", "fake"]) { rmSync(join(root, dir), { recursive: true, force: true }); mkdirSync(join(root, dir), { recursive: true }); }
  writeFileSync(join(root, "policy.toml"), POLICY);
  writeConnectorCache(join(root, "cache"));
  pb = createPlugboard();
});
afterEach(() => pb.close());
const calls = () => (existsSync(join(fake, "calls.jsonl")) ? readFileSync(join(fake, "calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
const NOTE = { connector: "slack", tool: "create-note", args: { text: "n" }, profile: "executor" };

describe("batch", () => {
  test("async iterables in and out: { id, ok, value, raw, via } or { id, ok: false, error }, in input order when asked", async () => {
    async function* lines() {
      yield { id: "a", connector: "slack", tool: "search-public", args: { query: "x" } };
      yield { id: "w", connector: "slack", tool: "send-message", args: { channel_id: "D1", message: "hi" }, profile: "executor" };
      yield { connector: "slack", tool: "search-public", args: { query: "y" } };
    }
    const out = await Array.fromAsync(pb.batch(lines(), { ordered: true }));
    expect(out.map(r => r.id)).toEqual(["a", "w", 2]);
    expect(Object.keys(out[0]!).sort()).toEqual(["id", "ok", "raw", "value", "via"]);
    expect(out[0]).toMatchObject({ ok: true, value: { matches: [{ user: "jose" }, { user: "ana" }] }, via: "claude-code" });
    const refused = out[1]!;
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.error).toBeInstanceOf(PlugboardError); expect(refused.error.code).toBe("POLICY_DENIED"); }
    expect(calls().filter(c => c.tool.endsWith("send_message"))).toHaveLength(0);
  });

  test("the module's batch is the default instance's", async () => {
    const { batch } = await import("../src/index");
    const out = await Array.fromAsync(batch([{ connector: "slack", tool: "search-public", args: { query: "x" } }]));
    expect(out).toMatchObject([{ id: 0, ok: true }]);
    const { close } = await import("../src/index");
    await close();
  });
});

describe("call", () => {
  test("reads: { value, raw, via }, by connector ID and the CLI's short tool name", async () => {
    const r = await pb.call({ connector: "slack", tool: "search-public", args: { query: "x" } });
    expect(r.value).toMatchObject({ matches: [{ user: "jose" }, { user: "ana" }] });
    expect(r.raw.content).toBeArray();
    expect(r.via).toBe("claude-code");
    expect(calls()).toEqual([{ tool: "mcp__claude_ai_Slack__slack_search_public", args: { query: "x" } }]);
  });

  test("one session serves every call, and takes each connector on as it is first called", async () => {
    await pb.call({ connector: "slack", tool: "search-public", args: { query: "x" } });
    writeFileSync(join(fake, "gmail-connected"), "1");
    await pb.call({ connector: "gmail", tool: "list-labels" }); // the fake answers it as a search
    await pb.call({ connector: "slack", tool: "search-public", args: { query: "y" } });
    expect(calls()).toHaveLength(3);
  });

  test("only reads: a write tool is refused, with a pointer to write()", async () => {
    const error = await pb.call({ connector: "slack", tool: "send-message", args: { channel_id: "D1", message: "hi" }, profile: "executor" }).catch(e => e);
    expect(error).toBeInstanceOf(PlugboardError);
    expect(error.code).toBe("POLICY_DENIED");
    expect(error.hints.join(" ")).toContain("write(");
    expect(calls()).toHaveLength(0);
  });

  test("errors are PlugboardError with the CLI's codes and exit codes", async () => {
    const error = await pb.call({ connector: "nowhere", tool: "x" }).catch(e => e);
    expect(error).toBeInstanceOf(PlugboardError);
    expect(error).toMatchObject({ code: "NOT_FOUND", exitCode: 2 });
  });

  test("a read cancelled is dropped", async () => {
    const cancel = new AbortController();
    const pending = pb.call({ connector: "slack", tool: "search-public", args: { query: "hang" }, signal: cancel.signal, timeoutMs: 10_000 });
    setTimeout(() => cancel.abort(), 50);
    const started = Date.now();
    expect((await pending.catch(e => e)).code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("plan and write", () => {
  test("a plan is plain JSON that carries its request; write sends it once under a key, then replays", async () => {
    const plan = JSON.parse(JSON.stringify(pb.plan(NOTE)));
    expect(plan.request).toEqual({ connector: "slack", tool: "create-note", args: { text: "n" }, profile: "executor" });
    expect(plan.hash).toStartWith("sha256:");
    const sent = await pb.write(plan, { key: "note-1", profile: "executor" });
    expect(sent).toMatchObject({ sent: true, key: "note-1", via: "claude-code" });
    expect(calls()).toEqual([{ tool: "mcp__claude_ai_Slack__slack_create_note", args: { text: "n", idempotency_key: "note-1" } }]);
    expect(await pb.write(plan, { key: "note-1", profile: "executor" })).toMatchObject({ replayed: true, key: "note-1" });
    expect(calls()).toHaveLength(1);
  });

  test("a plan edited in transit is refused: write plans the request again and checks the hash", async () => {
    const plan = pb.plan(NOTE);
    const edited = { ...plan, request: { ...plan.request, args: { text: "WIRE ALL THE MONEY" } } };
    expect((await pb.write(edited, { key: "note-2", profile: "executor" }).catch(e => e)).code).toBe("POLICY_DENIED");
    expect(calls()).toHaveLength(0);
  });

  test("the writer picks the profile, as the CLI's --as does: the plan's is never trusted", async () => {
    const plan = pb.plan(NOTE); // planned under executor
    expect((await pb.write(plan, { key: "note-3" }).catch(e => e)).code).toBe("POLICY_DENIED"); // the instance's profile: default, read only
    const promoted = { ...plan, request: { ...plan.request, profile: "admin" } };
    expect((await pb.write(promoted, { key: "note-3" }).catch(e => e)).code).toBe("POLICY_DENIED");
    expect(calls()).toHaveLength(0);
    expect(await pb.write(plan, { key: "note-3", profile: "executor" })).toMatchObject({ sent: true });
    const executor = createPlugboard({ profile: "executor" });
    try { expect(await executor.write(plan, { key: "note-4" })).toMatchObject({ sent: true }); } finally { await executor.close(); }
  });

  test("a write needs a key", async () => {
    expect((await pb.write(pb.plan(NOTE), { key: "", profile: "executor" }).catch(e => e)).code).toBe("VALIDATION_ERROR");
  });
});

describe("instances and settings", () => {
  test("createPlugboard takes its own policy file and profile", async () => {
    const other = join(root, "other.toml");
    writeFileSync(other, `transport = "claude-code"\n[profiles.reader]\nmode = "read"\ndeny = ["slack:slack_search_public"]\n`);
    const reader = createPlugboard({ policy: other, profile: "reader" });
    try { expect((await reader.call({ connector: "slack", tool: "search-public", args: { query: "x" } }).catch(e => e)).code).toBe("POLICY_DENIED"); }
    finally { await reader.close(); }
  });

  test("an unknown transport is a usage error", async () => {
    expect((await pb.call({ connector: "slack", tool: "search-public", args: { query: "x" }, transport: "fast" as never }).catch(e => e)).code).toBe("VALIDATION_ERROR");
  });
});
