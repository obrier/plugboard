import { afterEach, expect, test } from "bun:test";
import { ClaudeConnectors, DiscoveryTimeoutError } from "../src/bridge/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clients: ClaudeConnectors[] = [];
const directories: string[] = [];
async function connect(options: Parameters<typeof ClaudeConnectors.connect>[0] = {}) {
  const client = await ClaudeConnectors.connect({
    claudePath: `${import.meta.dir}/fixtures/claude-control.ts`,
    requestTimeoutMs: 2_000,
    ...options,
  });
  clients.push(client);
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function schemaFixture(mode = "ok", schemaTimeoutMs = 3_000) {
  const cwd = await mkdtemp(join(tmpdir(), "connector-schema-test-"));
  directories.push(cwd);
  await Bun.write(join(cwd, "schema-mode"), mode);
  return { cwd, client: await connect({ cwd, schemaTimeoutMs }) };
}

test("enriches tools by name, shares capture work, caches defensively, and refreshes explicitly", async () => {
  const { cwd, client } = await schemaFixture();
  const [first, second] = await Promise.all([
    client.listTools({ includeSchemas: true }), client.listTools({ includeSchemas: true }),
  ]);
  expect(first[0]).toMatchObject({ description: "Search mail", serverName: "claude.ai Mail", inputSchema: { required: ["query"] } });
  expect(first).toEqual(second);
  first[0]!.inputSchema.required = [];
  expect((await client.listTools({ includeSchemas: true }))[0]!.inputSchema.required).toEqual(["query"]);
  expect(await Bun.file(join(cwd, "schema-captures")).text()).toBe("capture\n");
  await client.listTools({ includeSchemas: true, refreshSchemas: true });
  expect(await Bun.file(join(cwd, "schema-captures")).text()).toBe("capture\ncapture\n");
  expect((await client.callTool(first[0]!.name, { value: "still works" })).structuredContent).toMatchObject({ value: "still works" });
});

test("rejects incomplete schemas without caching the failure", async () => {
  const { cwd, client } = await schemaFixture("missing");
  await expect(client.listTools({ includeSchemas: true })).rejects.toThrow("Capture differs");
  await Bun.write(join(cwd, "schema-mode"), "ok");
  expect((await client.listTools({ includeSchemas: true }))).toHaveLength(2);
});

test("refuses captures with nonzero model usage", async () => {
  const { client } = await schemaFixture("usage");
  await expect(client.listTools({ includeSchemas: true })).rejects.toThrow();
});

test("bounds schema capture time and leaves tool calls usable", async () => {
  const { client } = await schemaFixture("hang", 700);
  await expect(client.listTools({ includeSchemas: true })).rejects.toThrow("timed out");
  expect((await client.callTool("mcp__claude_ai_Mail__search", { value: "ok" })).structuredContent).toMatchObject({ value: "ok" });
});

test("closing cancels an active schema capture", async () => {
  const { cwd, client } = await schemaFixture("hang");
  const outcome = client.listTools({ includeSchemas: true }).catch(error => error);
  const until = Date.now() + 2_000;
  while (!await Bun.file(join(cwd, "schema-captures")).exists() && Date.now() < until) await Bun.sleep(10);
  expect(await Bun.file(join(cwd, "schema-captures")).exists()).toBe(true);
  await client.close();
  expect((await outcome).message).toContain("closed");
});

test("closing during schema discovery does not leave a pending control request", async () => {
  const { client } = await schemaFixture();
  await client.listTools();
  const outcome = client.listTools({ includeSchemas: true }).catch(error => error);
  await Bun.sleep(100);
  await client.close();
  expect((await outcome).message).toContain("closed");
});

test("discovers tools from every settled connector with unambiguous callable names", async () => {
  const client = await connect();
  const tools = await client.listTools();
  expect(tools.map(tool => tool.name)).toEqual([
    "mcp__claude_ai_Mail__search", "mcp__claude_ai_Drive__search",
  ]);
  expect(tools[0]).toMatchObject({ serverName: "claude.ai Mail", toolName: "search", annotations: { readOnly: true } });
  expect((await client.listServers()).find(server => server.name === "claude.ai Slack")?.status).toBe("needs-auth");
  const result = await client.callTool(tools[1]!.name, { value: "résumé" });
  expect(result.structuredContent).toEqual({ tool: "mcp__claude_ai_Drive__search", value: "résumé" });
});

// Live failure, 2026-10-19: a spawned Claude Code that was not logged in listed zero servers
// forever, and the only evidence was a bare "Timed out" stack trace. The error now carries the
// last snapshot so a caller can tell "nothing loaded" from "one server still connecting".
test.each([
  ["empty", [] as string[]],
  ["pending", ["claude.ai Drive"]],
])("discovery that never settles (%s) rejects with the last snapshot", async (mode, pending) => {
  const cwd = await mkdtemp(join(tmpdir(), "connector-status-test-"));
  directories.push(cwd);
  await Bun.write(join(cwd, "status-mode"), mode);
  const client = await connect({ cwd, discoveryTimeoutMs: 600 });
  const error = await client.listTools().catch(e => e);
  expect(error).toBeInstanceOf(DiscoveryTimeoutError);
  expect(error.message).toBe("Timed out waiting for connector discovery");
  expect(error.servers.filter((s: { status: string }) => s.status === "pending").map((s: { name: string }) => s.name)).toEqual(pending);
  expect(error.servers.length).toBe(mode === "empty" ? 0 : 3);
});

test("uses unique UUIDs and matches concurrent responses that arrive out of order", async () => {
  const client = await connect();
  const first = client.callTool("mcp__claude_ai_Mail__search", { value: "first", delay: 60 });
  const second = client.callTool("mcp__claude_ai_Mail__search", { value: "second" });
  expect((await second).structuredContent).toMatchObject({ value: "second" });
  expect((await first).structuredContent).toMatchObject({ value: "first" });
});

test("rejects control errors and a timed-out call without breaking subsequent requests", async () => {
  const client = await connect();
  await expect(client.callTool("mcp__claude_ai_Mail__search", { action: "fail" })).rejects.toThrow("needs authentication");
  await expect(client.request({ subtype: "mcp_call", tool: "mcp__claude_ai_Mail__search", arguments: { delay: 200 } }, { timeoutMs: 20 })).rejects.toThrow("Timed out");
  const cost = await client.request<{ text: string }>({ subtype: "get_session_cost" });
  expect(cost).toEqual({ text: "zero" });
});

test("rejects pending calls when the child exits", async () => {
  const client = await connect();
  await expect(client.callTool("mcp__claude_ai_Mail__search", { action: "exit" })).rejects.toThrow("closed stdout");
});

test("close rejects pending and future requests and can be called twice", async () => {
  const client = await connect();
  const pending = client.callTool("mcp__claude_ai_Mail__search", { delay: 500 });
  const outcome = pending.then(() => undefined, error => error);
  await client.close();
  expect(await outcome).toBeInstanceOf(Error);
  expect((await outcome).message).toContain("closed");
  await client.close();
  await expect(client.listTools()).rejects.toThrow("closed");
});

test("the child has no MCP output cap, whatever the parent sets: results over it would come back as a notice", async () => {
  const saved = process.env.MAX_MCP_OUTPUT_TOKENS;
  process.env.MAX_MCP_OUTPUT_TOKENS = "1000";
  try {
    const client = await connect();
    const result = await client.callTool<{ value: string }>("mcp__fake__echo", { action: "env", name: "MAX_MCP_OUTPUT_TOKENS" });
    expect(Number(result.structuredContent?.value)).toBeGreaterThanOrEqual(1_000_000);
  } finally {
    if (saved === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS; else process.env.MAX_MCP_OUTPUT_TOKENS = saved;
  }
});

test("every child skips Claude Code's nonessential traffic: its telemetry flush cost ~600 ms on each close", async () => {
  const client = await connect();
  const result = await client.callTool<{ value: string }>("mcp__fake__echo", { action: "env", name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" });
  expect(result.structuredContent?.value).toBe("1");
});

// A program that used Claude Code and never closed it still exits at once, and takes Claude Code with it.
for (const target of ["bun", "node"] as const)
  // The WSL2 job has no Node: the other jobs run the Node case.
  test.skipIf(target === "node" && !Bun.which("node"))(`an open client never keeps a program from exiting, and is stopped when it exits (${target})`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "connector-exit-test-"));
    directories.push(cwd);
    const script = join(cwd, "use.ts");
    await Bun.write(script, `import { ClaudeConnectors } from ${JSON.stringify(join(import.meta.dir, "../src/bridge/client"))};
const client = await ClaudeConnectors.connect({ claudePath: ${JSON.stringify(`${import.meta.dir}/fixtures/claude-control.ts`)}, cwd: ${JSON.stringify(cwd)} });
await client.listServers();
console.log("used");
`);
    let cmd = ["bun", script];
    if (target === "node") {
      const out = join(cwd, "use.mjs");
      expect(Bun.spawnSync(["bun", "build", script, "--target=node", `--outfile=${out}`]).exitCode).toBe(0);
      cmd = ["node", out];
    }
    const started = Date.now();
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exit = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "hung")]);
    if (exit === "hung") proc.kill();
    expect(exit).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("used");
    expect(Date.now() - started).toBeLessThan(8_000);
    const pid = Number(await Bun.file(join(cwd, "pid")).text());
    await Bun.sleep(200);
    expect(() => process.kill(pid, 0)).toThrow(); // Claude Code was stopped with it
  }, 20_000);
