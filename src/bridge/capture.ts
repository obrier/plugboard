// Experimental schema discovery using Claude Code's request preparation.
// The model endpoint is a loopback server which rejects every request.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { findClaude } from "../platform";
import { join } from "node:path";

export type ToolSchema = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Per-session variables a parent Claude Code exports into its Bash tool (session ids, the host
// messaging socket and token, the CLAUDECODE marker). The child is its own session and must not
// inherit them. Auth-carrying variables are kept.
// The child never feeds a model, so Claude Code's MCP output cap only loses data: a text result over
// it comes back as an "Output has been saved to" notice. A cap set by the parent is lifted.
const KEEP = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]);
export function childEnv(source: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (KEEP.has(key) || !(key === "CLAUDECODE" || key === "CLAUDE_PID" || /^CLAUDE_(CODE|AGENT_SDK|EFFORT|PREVIEW)_?/.test(key))) env[key] = value;
  }
  env.MAX_MCP_OUTPUT_TOKENS = "1000000000";
  return env;
}

export type SchemaCaptureOptions = {
  claudePath?: string;
  cwd?: string;
  timeoutMs?: number;
  discoveryTimeoutMs?: number;
  signal?: AbortSignal;
};

export async function captureConnectorSchemas(options: SchemaCaptureOptions = {}) {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? 30_000;
  for (const timeout of [timeoutMs, discoveryTimeoutMs])
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Timeout must be a positive finite number");
  const ownedDirectory = options.cwd ? undefined : await mkdtemp(join(tmpdir(), "claude-schema-capture-"));
  const cwd = options.cwd ?? ownedDirectory!;
  const requests: { method: string; path: string; connectorTools: number }[] = [];
  let schemas: ToolSchema[] = [];
  const rejection = "Local schema capture only; no model is available.";
  const server = await (async () => { try { return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      // Never retain headers, messages, system prompts, or account metadata.
      let body: unknown;
      try { body = await request.json(); } catch { /* e.g. HEAD /api/hello */ }
      const definitions = record(body) && Array.isArray(body.tools) ? body.tools : [];
      const tools: ToolSchema[] = [];
      for (const tool of definitions) {
        if (!record(tool) || typeof tool.name !== "string" || !tool.name.startsWith("mcp__")) continue;
        if (!record(tool.input_schema)) continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          inputSchema: tool.input_schema,
        });
      }
      requests.push({ method: request.method, path: new URL(request.url).pathname, connectorTools: tools.length });
      if (tools.length > schemas.length) schemas = tools;
      // No forwarding and no synthetic model response or tool calls.
      return Response.json({ type: "error", error: {
        type: "invalid_request_error", message: rejection,
      } }, { status: 400 });
    },
  }); } catch (error) {
    if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
    throw error;
  } })();

  let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let initTools: string[] = [];
  let result: Record<string, unknown> | undefined;
  let reading: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  const abort = () => { if (proc?.exitCode === null) proc.kill("SIGKILL"); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    // CRITICAL: Bun 1.4.0's default spawn environment did not reflect runtime
    // process.env assignments in our test. Always pass an explicit env object.
    const env: Record<string, string | undefined> = {
      ...childEnv(),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"])
      delete env[key];
    proc = Bun.spawn([
      options.claudePath ?? findClaude(),
      "--print", "--verbose", "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--no-session-persistence", "--setting-sources", "",
      "--settings", '{"disableAllHooks":true}', "--tools", "",
      "--permission-mode", "dontAsk", "--no-chrome",
    ], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    deadline = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    draining = (async () => {
      for await (const _chunk of proc!.stderr as ReadableStream<Uint8Array>) { /* discard diagnostics */ }
    })();
    void draining.catch(() => {});
    const decoder = new TextDecoder();
    let buffer = "";
    let streamClosed = false;
    const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    function send(message: object) {
      options.signal?.throwIfAborted();
      if (streamClosed) throw new Error("Claude Code closed during discovery");
      proc!.stdin.write(JSON.stringify(message) + "\n");
      proc!.stdin.flush();
    }
    function control(subtype: string) {
      const request_id = crypto.randomUUID();
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(request_id, { resolve, reject });
        send({ type: "control_request", request_id, request: { subtype } });
      });
    }
    function receive(line: string) {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!record(message)) return;
      if (message.type === "control_response" && record(message.response)) {
        const response = message.response;
        const waiter = typeof response.request_id === "string" ? pending.get(response.request_id) : undefined;
        if (waiter) {
          pending.delete(response.request_id as string);
          if (response.subtype === "success") waiter.resolve(record(response.response) ? response.response : {});
          else waiter.reject(new Error("Claude Code rejected schema-probe initialization/discovery"));
        }
      }
      if (message.type === "control_request") send({ type: "control_response", response: {
        subtype: "error", request_id: message.request_id, error: "Schema probe does not service host requests",
      } });
      if (message.type === "system" && message.subtype === "init" && Array.isArray(message.tools))
        initTools = message.tools.filter((name): name is string => typeof name === "string" && name.startsWith("mcp__"));
      if (message.type === "result") { result = message; proc!.stdin.end(); }
    }
    reading = (async () => {
      try {
        for await (const chunk of proc!.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            receive(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) receive(buffer);
      } finally {
        streamClosed = true;
        for (const waiter of pending.values()) waiter.reject(new Error("Claude Code closed during discovery"));
        pending.clear();
      }
    })();
    void reading.catch(() => {});
    await control("initialize");
    // CLI startup discovers connectors asynchronously. Preparing a request too
    // soon produces an empty tools array even when connectors are configured.
    const discoveryDeadline = Date.now() + discoveryTimeoutMs;
    while (true) {
      const status = await control("mcp_status");
      assert.ok(Array.isArray(status.mcpServers));
      if (status.mcpServers.length && status.mcpServers.every(server => record(server) && server.status !== "pending")) break;
      assert.ok(Date.now() < discoveryDeadline, "Connector discovery did not finish");
      await Bun.sleep(200);
    }
    send({ type: "user", message: { role: "user", content: "Local schema capture probe." },
      parent_tool_use_id: null, session_id: crypto.randomUUID() });
    await reading;
    await proc.exited;
    await draining;
    assert.ok(!timedOut, "Schema capture timed out");
    assert.ok(schemas.length > 0, "The local endpoint received no connector schemas");
    assert.deepEqual(schemas.map(tool => tool.name).sort(), [...initTools].sort(), "Capture differs from initialized connector tools");
    assert.ok(result && typeof result.result === "string" && result.result.includes(rejection), "Expected the local API rejection");
    assert.equal(result.total_cost_usd, 0);
    assert.ok(record(result.usage));
    assert.equal(result.usage.input_tokens, 0);
    assert.equal(result.usage.output_tokens, 0);
    assert.equal(result.usage.cache_read_input_tokens ?? 0, 0);
    assert.equal(result.usage.cache_creation_input_tokens ?? 0, 0);
    return { schemas, verification: {
      toolCount: schemas.length, requests, modelEndpoint: "loopback (no forwarding)",
      totalCostUsd: result.total_cost_usd, inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens, bunVersion: Bun.version,
    } };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timedOut) throw new Error("Schema capture timed out");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (deadline) clearTimeout(deadline);
    abort();
    if (proc) await proc.exited;
    await Promise.allSettled([reading, draining]);
    server.stop(true);
    if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { schemas, verification } = await captureConnectorSchemas();
  const outputDir = await mkdtemp(join(tmpdir(), "claude-connector-schemas-"));
  await Bun.write(join(outputDir, "schemas.json"), JSON.stringify(schemas, null, 2));
  await Bun.write(join(outputDir, "verification.json"), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify(verification, null, 2));
  console.log(`PASS — output: ${outputDir}`);
}
