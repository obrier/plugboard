// End-to-end through the real CLI, against test/fixtures/fake-claude.ts. No network, no account:
// every "write" here lands in the fake's calls.jsonl, never in a real connector.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCapture } from "../src/cache";

const root = mkdtempSync(join(tmpdir(), "connectors-axi-test-"));
const fake = join(root, "fake");
const cli = join(import.meta.dir, "../src/cli.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const POLICY = `
[transforms]
"slack:slack_search_public.after" = "unix"
[profiles.gather]
mode = "read"
allow = ["slack:*", "gmail:*"]
[profiles.executor]
mode = "write"
allow = ["slack:slack_send_message", "slack:slack_delete_message"]
[profiles.agent]
mode = "write"
allow = ["slack:slack_send_message"]
allow_in_agent = true
`;

beforeEach(() => {
  for (const dir of ["cache", "state", "fake"]) { rmSync(join(root, dir), { recursive: true, force: true }); mkdirSync(join(root, dir), { recursive: true }); }
  writeFileSync(join(root, "policy.toml"), POLICY);
  const servers = [
    { name: "claude.ai Slack", status: "connected", tools: [
      { name: "slack_search_public", annotations: { readOnly: true } }, { name: "slack_send_message" },
      { name: "slack_delete_message", annotations: { destructive: true } }] },
    { name: "claude.ai Gmail", status: "connected", tools: [{ name: "list_labels", annotations: { readOnly: true } }] },
  ];
  const schemas = [
    { name: "mcp__claude_ai_Slack__slack_search_public", inputSchema: { type: "object", properties: { query: { type: "string" }, after: { type: "string" }, limit: { type: "integer" } } } },
    { name: "mcp__claude_ai_Slack__slack_send_message", inputSchema: { type: "object", required: ["channel_id", "message"], properties: { channel_id: { type: "string" }, message: { type: "string" } } } },
    { name: "mcp__claude_ai_Slack__slack_delete_message", inputSchema: { type: "object", properties: { ts: { type: "string" } } } },
    { name: "mcp__claude_ai_Gmail__list_labels", inputSchema: { type: "object", properties: {} } },
  ];
  const { index, manifests } = mergeCapture(undefined, servers as never, schemas);
  mkdirSync(join(root, "cache/manifests"), { recursive: true });
  writeFileSync(join(root, "cache/index.json"), JSON.stringify({ ...index, testedVersions: ["9.9.9"] }));
  for (const m of manifests) writeFileSync(join(root, "cache/manifests", `${m.id}.json`), JSON.stringify(m));
});

async function run(args: string[], o: { stdin?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, CONNECTORS_AXI_CACHE: join(root, "cache"), CONNECTORS_AXI_STATE: join(root, "state"),
    CONNECTORS_AXI_POLICY: join(root, "policy.toml"), CONNECTORS_AXI_CLAUDE: join(import.meta.dir, "fixtures/fake-claude.ts"), FAKE_DIR: fake, ...o.env };
  delete env.CLAUDECODE; // these tests run inside Claude Code; the tripwire test sets it back on purpose
  delete env.CONNECTORS_AXI_PROFILE;
  Object.assign(env, o.env);
  const proc = Bun.spawn(["bun", cli, ...args], { env, stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}
const calls = () => (existsSync(join(fake, "calls.jsonl")) ? readFileSync(join(fake, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const audit = () => readFileSync(join(root, "state/audit.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const SEND = ["slack", "send-message", "--channel-id", "D1", "--message", "hello"];
const planHash = async (args: string[]) => JSON.parse((await run([...args, "--plan", "--out", "json"])).stdout).hash as string;

test("read: transforms, unwrap, select, md; cost guard passes", async () => {
  const r = await run(["slack", "search-public", "--query", "x", "--after", "-1d", "--select", "user", "--out", "json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ results: "# Results for x", matches: [{ user: "jose" }, { user: "ana" }] });
  const after = Number(calls()[0].args.after);
  expect(Math.abs(after - (Date.now() / 1000 - 86400))).toBeLessThan(60);
  expect(typeof calls()[0].args.after).toBe("string"); // the schema says string
  expect((await run(["slack", "search-public", "--query", "y", "--where", "n > 1", "--select", "user"])).stdout).toContain("ana");
});

test("auth: a needs-auth connector is AUTH_REQUIRED (exit 4) before any call", async () => {
  const r = await run(["gmail", "list-labels"]);
  expect(r.code).toBe(4);
  expect(r.stdout).toContain("AUTH_REQUIRED");
  expect(calls()).toHaveLength(0);
});

test("usage errors exit 2; unknown tool suggests near names; upstream isError exits 1", async () => {
  expect((await run(["slack", "search-public", "--limit", "x"])).code).toBe(2);
  const near = await run(["slack", "search"]);
  expect(near.code).toBe(2);
  expect(near.stdout).toContain("search-public");
  expect((await run(["slack", "search-public", "--query", "iserror"])).code).toBe(1);
});

test("policy: write tools need a write profile, --write, a key and the approved hash", async () => {
  expect((await run(SEND)).code).toBe(3);
  expect((await run([...SEND, "--as", "gather", "--write"])).code).toBe(3);
  expect((await run([...SEND, "--as", "executor", "--write", "--expect-hash", "sha256:00"])).code).toBe(2); // no key
  expect((await run([...SEND, "--as", "executor", "--write", "--write-key", "k", "--expect-hash", "sha256:00"])).code).toBe(3); // wrong hash
  expect((await run(["slack", "delete-message", "--ts", "1", "--as", "executor", "--write", "--write-key", "k", "--expect-hash",
    await planHash(["slack", "delete-message", "--ts", "1"])])).code).toBe(3); // destructive, not opted in
  expect(calls()).toHaveLength(0);
});

test("write: sends once, audits attempt then ok with ref, replays without calling again", async () => {
  const hash = await planHash(SEND);
  const args = [...SEND, "--as", "executor", "--write", "--write-key", "out-1", "--expect-hash", hash];
  const first = await run(args);
  expect(first.code).toBe(0);
  expect(first.stdout).toContain("sent: true");
  expect(audit().map(e => e.status)).toEqual(["attempt", "ok"]);
  expect(audit()[1].ref).toBe("1762243803.1234");
  expect(audit()[0].payload_sha256).toBe(hash);
  expect(JSON.stringify(audit())).not.toContain("hello"); // hashes, never payloads
  const again = await run(args);
  expect(again.code).toBe(0);
  expect(again.stdout).toContain("replayed: true");
  expect(calls()).toHaveLength(1);
});

test("write: a timeout is WRITE_OUTCOME_UNKNOWN (exit 6), blocks the key until resolved, never retries", async () => {
  const send = ["slack", "send-message", "--channel-id", "D1", "--message", "hang"];
  const args = [...send, "--as", "executor", "--write", "--write-key", "out-2", "--expect-hash", await planHash(send), "--deadline", "300ms"];
  const first = await run(args);
  expect(first.code).toBe(6);
  expect(audit().map(e => e.status)).toEqual(["attempt", "unknown"]);
  expect((await run(args)).code).toBe(6);
  expect(calls()).toHaveLength(1);
  expect((await run(["audit", "--unresolved"])).stdout).toContain("out-2");
  expect((await run(["audit", "resolve", "out-2", "--sent"])).code).toBe(0);
  expect((await run(args)).stdout).toContain("replayed: true");
  expect(calls()).toHaveLength(1);
});

test("write: refused inside a Claude Code session unless the profile allows it", async () => {
  const hash = await planHash(SEND);
  const tail = ["--write", "--write-key", "out-3", "--expect-hash", hash];
  const blocked = await run([...SEND, "--as", "executor", ...tail], { env: { CLAUDECODE: "1" } });
  expect(blocked.code).toBe(3);
  expect(blocked.stdout).toContain("CLAUDECODE");
  expect((await run([...SEND, "--as", "agent", ...tail], { env: { CLAUDECODE: "1" } })).code).toBe(0);
});

test("cost guard: a nonzero session cost exits 10", async () => {
  writeFileSync(join(fake, "cost"), "1");
  const r = await run(["slack", "search-public", "--query", "x"]);
  expect(r.code).toBe(10);
  expect(r.stdout).toContain("COST_GUARD");
});

test("batch: per-line results, 429 backoff, auth fail-fast, writes refused, bad lines isolated", async () => {
  const lines = [
    { id: "a", connector: "slack", tool: "search-public", args: { query: "one" }, select: "user", items: "matches" },
    { id: "rl", connector: "slack", tool: "slack_search_public", args: { query: "ratelimit" } },
    { id: "g", connector: "gmail", tool: "list-labels" },
    { id: "w", connector: "slack", tool: "send-message", args: { channel_id: "D1", message: "x" } },
    { id: "v", connector: "slack", tool: "search-public", args: { limit: "many" } },
  ].map(l => JSON.stringify(l)).join("\n") + "\nnot json\n";
  const r = await run(["batch", "--as", "gather", "--ordered"], { stdin: lines });
  const out = r.stdout.trim().split("\n").map(l => JSON.parse(l));
  expect(r.code).toBe(7);
  expect(out.map(o => o.id)).toEqual(["a", "rl", "g", "w", "v", 5]);
  expect(out[0]).toMatchObject({ ok: true, result: { matches: [{ user: "jose" }, { user: "ana" }] } });
  expect(out[1]).toMatchObject({ ok: true }); // two 429s, then success
  expect(out[2]).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } }); // gmail needs-auth: no call made
  expect(out[3]).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
  expect(out[4]).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  expect(out[5]).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  expect(calls().filter(c => c.tool.endsWith("send_message"))).toHaveLength(0);
  expect(calls().filter(c => c.args.query === "ratelimit")).toHaveLength(3);
}, 20_000);

test("batch: an auth failure fails the rest of that connector fast", async () => {
  const lines = ["auth", "two", "three"].map(q => JSON.stringify({ id: q, connector: "slack", tool: "search-public", args: { query: q } })).join("\n");
  const r = await run(["batch", "--as", "gather", "--ordered", "--concurrency", "1"], { stdin: lines });
  const out = r.stdout.trim().split("\n").map(l => JSON.parse(l));
  expect(out.map(o => o.error?.code)).toEqual(["AUTH_REQUIRED", "AUTH_REQUIRED", "AUTH_REQUIRED"]);
  expect(calls()).toHaveLength(1);
  expect(r.code).toBe(7);
});

test("doctor: gate exit codes, blind connectors, drift and audit warnings", async () => {
  const ok = await run(["doctor", "--as", "gather", "--out", "json"]);
  const result = JSON.parse(ok.stdout);
  expect(result.blind).toEqual(["gmail"]); // gather names gmail; the fake says needs-auth
  expect(ok.code).toBe(7);
  expect(result.checks.find((c: { check: string }) => c.check === "zero-cost").status).toBe("ok");
  expect(result.checks.find((c: { check: string }) => c.check === "drift:slack")).toBeUndefined();
  writeFileSync(join(fake, "gmail-connected"), "1");
  const green = await run(["doctor", "--as", "gather"]);
  expect(green.stdout).toContain("drift:gmail"); // gmail has no cached manifest now that it connects
  expect(green.code).toBe(0);
  writeFileSync(join(fake, "cost"), "1");
  expect((await run(["doctor"])).code).toBe(10);
});

test("home, listing, help, find and policy never spawn claude", async () => {
  const env = { CONNECTORS_AXI_CLAUDE: "/nonexistent/claude" };
  expect((await run([], { env })).stdout).toContain("connectors[2]");
  expect((await run(["slack"], { env })).stdout).toContain("send-message,write");
  expect((await run(["slack", "send-message", "--help"], { env })).stdout).toContain("--channel-id <text>");
  expect((await run(["find", "search"], { env })).stdout).toContain("search-public");
  expect((await run(["policy", "--as", "executor", "slack"], { env })).stdout).toContain("send-message,write");
});

test("write handshake: --plan on the args file, then the write with that hash; an edited file is refused", async () => {
  const argsFile = join(root, "out-9.args.json");
  writeFileSync(argsFile, JSON.stringify({ channel_id: "D1", message: "approved text" }));
  const plan = JSON.parse((await run(["slack", "send-message", "--arg-file", argsFile, "--plan", "--out", "json"])).stdout);
  expect(plan).toMatchObject({ class: "write", payload: { channel_id: "D1", message: "approved text" } });
  const send = ["slack", "send-message", "--arg-file", argsFile, "--as", "executor", "--write", "--write-key", "out-9", "--expect-hash", plan.hash];
  writeFileSync(argsFile, JSON.stringify({ channel_id: "D1", message: "injected text" })); // changed after approval
  expect((await run(send)).code).toBe(3);
  expect(calls()).toHaveLength(0);
  writeFileSync(argsFile, JSON.stringify({ message: "approved text", channel_id: "D1" })); // same payload, other key order
  expect((await run(send)).code).toBe(0);
  expect(calls()).toEqual([{ tool: "mcp__claude_ai_Slack__slack_send_message", args: { message: "approved text", channel_id: "D1" } }]);
});
