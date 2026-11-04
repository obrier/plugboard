// End-to-end through the real CLI, against test/fixtures/fake-claude.ts. No network, no account:
// every "write" here lands in the fake's calls.jsonl, never in a real connector.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCapture } from "../src/cache";

const root = mkdtempSync(join(tmpdir(), "plugboard-test-"));
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
allow = ["slack:slack_send_message", "slack:slack_delete_message", "slack:slack_create_note"]
[profiles.agent]
mode = "write"
allow = ["slack:slack_send_message"]
allow_in_agent = true
`;

beforeEach(() => {
  for (const dir of ["cache", "state", "fake"]) { rmSync(join(root, dir), { recursive: true, force: true }); mkdirSync(join(root, dir), { recursive: true }); }
  writeFileSync(join(root, "policy.toml"), POLICY);
  rmSync(join(root, "transforms.toml"), { force: true });
  const servers = [
    { name: "claude.ai Slack", status: "connected", tools: [
      { name: "slack_search_public", annotations: { readOnly: true } }, { name: "slack_send_message" },
      { name: "slack_delete_message", annotations: { destructive: true } }, { name: "slack_create_note" }] },
    { name: "claude.ai Gmail", status: "connected", tools: [{ name: "list_labels", annotations: { readOnly: true } }] },
  ];
  const schemas = [
    { name: "mcp__claude_ai_Slack__slack_search_public", inputSchema: { type: "object", properties: { query: { type: "string" }, after: { type: "string" }, limit: { type: "integer" } } } },
    { name: "mcp__claude_ai_Slack__slack_send_message", inputSchema: { type: "object", required: ["channel_id", "message"], properties: { channel_id: { type: "string" }, message: { type: "string" } } } },
    { name: "mcp__claude_ai_Slack__slack_delete_message", inputSchema: { type: "object", properties: { ts: { type: "string" } } } },
    { name: "mcp__claude_ai_Slack__slack_create_note", inputSchema: { type: "object", properties: { text: { type: "string" }, idempotency_key: { type: "string" } } } },
    { name: "mcp__claude_ai_Gmail__list_labels", inputSchema: { type: "object", properties: {} } },
  ];
  const { index, manifests } = mergeCapture(undefined, servers as never, schemas);
  mkdirSync(join(root, "cache/manifests"), { recursive: true });
  writeFileSync(join(root, "cache/index.json"), JSON.stringify({ ...index, testedVersions: ["9.9.9"] }));
  for (const m of manifests) writeFileSync(join(root, "cache/manifests", `${m.id}.json`), JSON.stringify(m));
});

async function run(args: string[], o: { stdin?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, PLUGBOARD_CACHE: join(root, "cache"), PLUGBOARD_STATE: join(root, "state"),
    PLUGBOARD_POLICY: join(root, "policy.toml"), PLUGBOARD_TRANSFORMS: join(root, "transforms.toml"), PLUGBOARD_CLAUDE: join(import.meta.dir, "fixtures/fake-claude.ts"), FAKE_DIR: fake, ...o.env };
  delete env.CLAUDECODE; // these tests run inside Claude Code; the tripwire test sets it back on purpose
  delete env.PLUGBOARD_PROFILE;
  Object.assign(env, o.env);
  const proc = Bun.spawn(["bun", cli, ...args], { env, stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr, all: stdout + stderr };
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
  expect((await run(["slack", "search-public", "--query", "y", "--where", "n > 1", "--select", "user"])).all).toContain("ana");
});

test("transforms.toml: its transforms apply; a profile written into it does not exist", async () => {
  writeFileSync(join(root, "policy.toml"), POLICY.replace(/\[transforms\][^[]*/, ""));
  writeFileSync(join(root, "transforms.toml"), `[transforms]\n"slack:slack_search_public.after" = "unix"\n[profiles.sneaky]\nmode = "write"\nallow = ["slack:slack_send_message"]\nallow_in_agent = true\n`);
  expect((await run(["slack", "search-public", "--query", "x", "--after", "-1d"])).code).toBe(0);
  expect(Math.abs(Number(calls()[0].args.after) - (Date.now() / 1000 - 86400))).toBeLessThan(60);
  const plan = JSON.parse((await run([...SEND, "--as", "sneaky", "--plan", "--out", "json"])).stdout);
  expect(plan.decision).toBe('denied: Unknown profile "sneaky"');
});

test("with AXI on, an explicit --out keeps errors off stdout; without it, errors stay AXI on stdout", async () => {
  const env = { PLUGBOARD_AXI: "1" };
  for (const out of ["json", "md", "raw", "text"]) {
    const r = await run(["gmail", "list-labels", "--out", out], { env });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("AUTH_REQUIRED");
  }
  const axi = await run(["gmail", "list-labels"], { env });
  expect(axi.code).toBe(4);
  expect(axi.stdout).toContain("AUTH_REQUIRED");
  expect((await run(["gmail", "list-labels", "--out", "toon"], { env })).stdout).toContain("AUTH_REQUIRED");
});

test("auth: a needs-auth connector is AUTH_REQUIRED (exit 4) before any call", async () => {
  const r = await run(["gmail", "list-labels"]);
  expect(r.code).toBe(4);
  expect(r.all).toContain("AUTH_REQUIRED");
  expect(calls()).toHaveLength(0);
});

test("usage errors exit 2; unknown tool suggests near names; upstream isError exits 1", async () => {
  expect((await run(["slack", "search-public", "--limit", "x"])).code).toBe(2);
  const near = await run(["slack", "search"]);
  expect(near.code).toBe(2);
  expect(near.all).toContain("search-public");
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
  expect(first.all).toContain("sent: true");
  expect(audit().map(e => e.status)).toEqual(["attempt", "ok"]);
  expect(audit()[1].ref).toBe("1762243803.1234");
  expect(audit()[0].payload_sha256).toBe(hash);
  expect(JSON.stringify(audit())).not.toContain("hello"); // hashes, never payloads
  const again = await run(args);
  expect(again.code).toBe(0);
  expect(again.all).toContain("replayed: true");
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
  expect((await run(["audit", "--unresolved"])).all).toContain("out-2");
  expect((await run(["audit", "resolve", "out-2", "--sent"])).code).toBe(0);
  expect((await run(args)).all).toContain("replayed: true");
  expect(calls()).toHaveLength(1);
});

test("write: refused inside a Claude Code session unless the profile allows it", async () => {
  const hash = await planHash(SEND);
  const tail = ["--write", "--write-key", "out-3", "--expect-hash", hash];
  const blocked = await run([...SEND, "--as", "executor", ...tail], { env: { CLAUDECODE: "1" } });
  expect(blocked.code).toBe(3);
  expect(blocked.all).toContain("CLAUDECODE");
  expect((await run([...SEND, "--as", "agent", ...tail], { env: { CLAUDECODE: "1" } })).code).toBe(0);
});

test("cost guard: a nonzero session cost exits 10", async () => {
  writeFileSync(join(fake, "cost"), "1");
  const r = await run(["slack", "search-public", "--query", "x"]);
  expect(r.code).toBe(10);
  expect(r.all).toContain("COST_GUARD");
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
  expect(green.all).toContain("drift:gmail"); // gmail has no cached manifest now that it connects
  expect(green.code).toBe(0);
  writeFileSync(join(fake, "cost"), "1");
  expect((await run(["doctor"])).code).toBe(10);
});

test("doctor probes a required connector with one of its own argument-free read tools", async () => {
  const result = JSON.parse((await run(["doctor", "--as", "gather", "--out", "json"])).stdout);
  expect(result.checks.find((c: { check: string }) => c.check === "read:slack")?.status).toBe("ok");
  expect(calls().map(c => c.tool)).toContain("mcp__claude_ai_Slack__slack_search_public");
});

test("doctor never probes a tool the profile denies", async () => {
  writeFileSync(join(root, "policy.toml"), `${POLICY}\n[profiles.narrow]\nmode = "read"\nallow = ["slack:*"]\ndeny = ["slack:slack_search_public"]\n`);
  const result = JSON.parse((await run(["doctor", "--as", "narrow", "--out", "json"])).stdout);
  expect(calls().map(c => c.tool)).not.toContain("mcp__claude_ai_Slack__slack_search_public");
  expect(result.checks.find((c: { check: string }) => c.check === "read:slack")).toMatchObject({ status: "info", detail: expect.stringContaining("not checked") });
});

test("doctor warns about aliases the policy defines, never about built-in ones", async () => {
  const policyCheck = async () => JSON.parse((await run(["doctor", "--out", "json"])).stdout).checks.find((c: { check: string }) => c.check === "policy").detail as string;
  expect(await policyCheck()).not.toContain("aliases to unknown connectors");
  writeFileSync(join(root, "policy.toml"), `${POLICY}\n[aliases]\nmine = "no-such-connector"\n`);
  expect(await policyCheck()).toContain("aliases to unknown connectors: mine");
});

test("AXI is on by default inside Claude Code; PLUGBOARD_AXI=0 turns it off", async () => {
  const env = { PLUGBOARD_CLAUDE: "/nonexistent/claude" };
  expect((await run([], { env: { ...env, CLAUDECODE: "1" } })).all).toContain("connectors[2]");
  expect((await run([], { env: { ...env, CLAUDECODE: "1", PLUGBOARD_AXI: "0" } })).all).toMatch(/connectors:\n\s+ID\s+STATUS/);
  expect((await run([], { env })).all).toMatch(/connectors:\n\s+ID\s+STATUS/);
});

test("home, listing, help, find and policy never spawn claude; plain by default, AXI with --axi", async () => {
  const env = { PLUGBOARD_CLAUDE: "/nonexistent/claude" };
  expect((await run([], { env })).all).toMatch(/connectors:\n\s+ID\s+STATUS/);
  expect((await run(["--axi"], { env })).all).toContain("connectors[2]");
  expect((await run(["slack"], { env })).all).toMatch(/send-message\s+write/);
  expect((await run(["slack", "--axi"], { env })).all).toContain("send-message,write");
  expect((await run(["slack", "send-message", "--help"], { env })).all).toContain("--channel-id <text>");
  expect((await run(["find", "search"], { env })).all).toContain("search-public");
  expect((await run(["policy", "--as", "executor", "slack"], { env })).all).toMatch(/send-message\s+write/);
});

test("errors: plain goes to stderr as `error: … (CODE)`; --axi keeps the AXI shape on stdout", async () => {
  const plain = await run(["slack", "nope"]);
  expect(plain.stdout).toBe("");
  expect(plain.stderr).toContain("error: slack has no tool \"nope\" (NOT_FOUND)");
  const axi = await run(["slack", "nope", "--axi"]);
  expect(axi.stdout).toContain("code: NOT_FOUND");
  expect(axi.code).toBe(2);
});

test("tool results: plain prints JSON or markdown; --axi prints TOON", async () => {
  expect(JSON.parse((await run(["slack", "search-public", "--query", "x", "--items", "matches", "--select", "user"])).stdout).matches).toEqual([{ user: "jose" }, { user: "ana" }]);
  expect((await run(["slack", "search-public", "--query", "x", "--out", "md"])).stdout).toContain("# Results for x");
  expect((await run(["slack", "search-public", "--query", "x", "--axi", "--items", "matches", "--select", "user"])).stdout).toContain("matches[2]{user}");
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

test("a tool's own idempotency_key is filled from --write-key, in the plan hash and in the call", async () => {
  const note = ["slack", "create-note", "--text", "n"];
  const plan = JSON.parse((await run([...note, "--write-key", "out-7", "--plan", "--out", "json"])).stdout);
  expect(plan.payload).toEqual({ text: "n", idempotency_key: "out-7" });
  expect(plan.hash).not.toBe(await planHash(note)); // the key is part of what was approved
  expect((await run([...note, "--as", "executor", "--write", "--write-key", "out-7", "--expect-hash", plan.hash])).code).toBe(0);
  expect(calls()[0].args).toEqual({ text: "n", idempotency_key: "out-7" });
});

test("usage: counts only real tool calls, maps UUID-named connectors by tool name, then ranks and caps listings", async () => {
  const dir = join(root, "transcripts/project");
  mkdirSync(dir, { recursive: true });
  const call = (name: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input: {} }] } });
  writeFileSync(join(dir, "s.jsonl"), [
    call("mcp__claude_ai_Slack__slack_send_message"),
    call("mcp__e9b0846e-2f83-452c-a4e3-1999125e1954__slack_send_message"), // desktop: UUID instead of the connector name
    call("mcp__e9b0846e-2f83-452c-a4e3-1999125e1954__slack_search_public"),
    call("mcp__other__unknown_tool"),
    JSON.stringify({ type: "user", message: { content: "deferred tools: mcp__claude_ai_Slack__slack_delete_message" } }), // a listing, not a call
  ].join("\n"));
  const env = { PLUGBOARD_TRANSCRIPTS: join(root, "transcripts") };
  const usage = await run(["usage", "--axi"], { env });
  expect(usage.all).toContain("calls: 3");
  const list = await run(["slack", "--axi"], { env });
  expect(list.all).toMatch(/send-message,write,2,[^\n]*\n\s+search-public,read,1,/);
  const { listTools } = await import("../src/call");
  const { loadManifest } = await import("../src/cache");
  const { parsePolicy } = await import("../src/policy");
  process.env.PLUGBOARD_CACHE = join(root, "cache");
  try {
    const capped = listTools(parsePolicy("", "p"), loadManifest("slack")!, { cap: 2 });
    expect(capped.tools.map(t => t.name)).toEqual(["send-message", "search-public"]);
    expect(capped.help[0]).toContain("2 more tools");
    expect(listTools(parsePolicy("", "p"), loadManifest("slack")!, { cap: 2, all: true }).tools).toHaveLength(4);
  } finally { delete process.env.PLUGBOARD_CACHE; }
  expect((await run(["slack", "--bogus"])).code).toBe(2);
});

test("doctor: a connector it can't probe gets a line saying so, not silence", async () => {
  const path = join(root, "cache/manifests/slack.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const tool of manifest.tools) tool.inputSchema.required = Object.keys(tool.inputSchema.properties ?? {}).slice(0, 1);
  writeFileSync(path, JSON.stringify(manifest));
  writeFileSync(join(fake, "gmail-connected"), "1");
  const r = await run(["doctor", "--as", "gather", "--out", "json"]);
  const checks: { check: string; status: string; detail: string }[] = JSON.parse(r.stdout).checks;
  expect(checks.find(c => c.check === "read:slack")).toMatchObject({ status: "info", detail: expect.stringContaining("not checked") });
  expect(checks.find(c => c.check === "read:gmail")?.status).toBe("ok");
  expect(r.code).toBe(0); // info never changes the exit code
});

describe("batch --axi and full results on disk", () => {
  const results = () => join(root, "state", "results");
  const runDirOf = (stdout: string) => /^run: (.+)$/m.exec(stdout)?.[1] ?? "";
  const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
  const lines = (...ls: object[]) => ls.map(l => JSON.stringify(l)).join("\n");

  test("writes every result to a private file and prints a manifest in input order, small results inline", async () => {
    const big = "y".repeat(40_000);
    const r = await run(["batch", "--as", "gather", "--axi"], { stdin: lines(
      { id: "a", connector: "slack", tool: "search-public", args: { query: "one" } },
      { id: "big", connector: "slack", tool: "search-public", args: { query: big } },
      { id: "w", connector: "slack", tool: "send-message", args: { channel_id: "D1", message: "x" } },
      { id: "s", connector: "slack", tool: "search-public", args: { query: "two" }, items: "matches", select: "user" },
    ) });
    expect(r.code).toBe(7);
    const dir = runDirOf(r.stdout);
    expect(dir.startsWith(results())).toBe(true);
    expect(mode(dir)).toBe("700");
    expect(r.stdout).toContain("results[4]{id,ok,ms,items,tokens,file}:");
    expect(r.stdout.indexOf("\n  a,true")).toBeLessThan(r.stdout.indexOf("\n  big,true"));
    expect(r.stdout).toMatch(/\n {2}big,true,\d+,2,~\d+K,big\.toon/);
    expect(r.stdout).toMatch(/\n {2}w,false,null,null,null,null\n/);
    expect(r.stdout).toContain("POLICY_DENIED");
    expect(readdirSync(dir).sort()).toEqual(["a.toon", "big.toon", "s.toon"]);
    for (const f of readdirSync(dir)) expect(mode(join(dir, f))).toBe("600");
    expect(readFileSync(join(dir, "big.toon"), "utf8")).toContain(big); // nothing cut
    expect(readFileSync(join(dir, "s.toon"), "utf8")).not.toContain("jose,1"); // select applied before writing
    expect(r.stdout).toContain("inline:");
    expect(r.stdout).not.toContain(big); // over the budget: in its file only
    expect(r.stdout).toMatch(/1 result\(s\) not inlined \(~\d+K tokens\)/);
  }, 20_000);

  test("--inline picks what goes inline; without the --axi flag, PLUGBOARD_AXI=1 still gets JSON lines", async () => {
    const input = lines({ id: "a", connector: "slack", tool: "search-public", args: { query: "one" } }, { id: "b", connector: "slack", tool: "search-public", args: { query: "two" } });
    const none = await run(["batch", "--as", "gather", "--axi", "--inline", "none"], { stdin: input });
    expect(none.stdout).not.toContain("inline:");
    const one = await run(["batch", "--as", "gather", "--axi", "--inline", "b"], { stdin: input });
    expect(one.stdout).toContain("Results for two");
    expect(one.stdout).not.toContain("Results for one");
    const jsonl = await run(["batch", "--as", "gather"], { stdin: input, env: { PLUGBOARD_AXI: "1" } });
    expect(jsonl.stdout.trim().split("\n").map(l => JSON.parse(l).id).sort()).toEqual(["a", "b"]);
    expect((await run(["batch", "--as", "gather", "--inline", "none"], { stdin: input })).code).not.toBe(0);
  }, 20_000);

  test("runs older than a day are removed by the next run", async () => {
    const old = join(results(), "b-old");
    mkdirSync(old, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    await run(["batch", "--as", "gather", "--axi"], { stdin: lines({ id: "a", connector: "slack", tool: "search-public", args: { query: "one" } }) });
    expect(existsSync(old)).toBe(false);
  }, 20_000);

  test("a single call cut at 1500 chars writes its full result and names the file", async () => {
    const long = "z".repeat(3000);
    const r = await run(["slack", "search-public", "--query", long, "--axi"]);
    const path = /full result: (\S+)/.exec(r.stdout)?.[1] ?? "";
    expect(path.startsWith(results())).toBe(true);
    expect(mode(path)).toBe("600");
    expect(readFileSync(path, "utf8")).toContain(long);
    expect((await run(["slack", "search-public", "--query", long, "--axi", "--full"])).stdout).not.toContain("full result:");
  });
});

test("a Claude Code it isn't allowed to start is explained as a permission problem, not a breaking update", async () => {
  const blocked = join(root, "claude-not-executable");
  writeFileSync(blocked, "#!/bin/sh\n");
  const r = await run(["slack", "search-public", "--query", "x"], { env: { PLUGBOARD_CLAUDE: blocked } });
  expect(r.code).toBe(10);
  expect(r.stderr).toContain("sandbox");
  expect(r.stderr).not.toContain("breaking update");
});
