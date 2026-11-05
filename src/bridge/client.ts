import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { findClaude } from "../platform";
import { join } from "node:path";
import { captureConnectorSchemas, childEnv, POLL_MS } from "./capture";
import { setTimeout as sleep } from "node:timers/promises";
import { runtime as detected, type Proc, type Runtime } from "../runtime";
import type { ToolSchema } from "./capture";
import { markNotSent } from "../errors";

export type ToolMetadata = {
  name: string;
  description?: string;
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
};
export type ConnectorServer = {
  name: string;
  status: string;
  scope?: string;
  transport?: string;
  error?: string;
  /** How Claude Code reaches it, as `mcp_status` reports it: a claude.ai connector's is `{type: "claudeai-proxy", url, id}`. */
  config?: Record<string, unknown>;
  tools: ToolMetadata[];
};
export type ConnectorTool = ToolMetadata & { serverName: string; toolName: string };
export type ConnectorToolWithSchema = ConnectorTool & ToolSchema;
export type ListToolsOptions = { includeSchemas?: boolean; refreshSchemas?: boolean; servers?: string[] };
export type ToolResult<T = unknown> = {
  content?: unknown;
  structuredContent?: T;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
export type ClientOptions = {
  claudePath?: string;
  cwd?: string;
  requestTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  schemaTimeoutMs?: number;
  /** Bun's or Node's process and server APIs; detected unless given (tests run both). */
  runtime?: Runtime;
};
export type ControlRequest = { subtype: string; [key: string]: unknown };

/** Discovery did not settle. Carries the last snapshot, so a caller can tell "N servers still
 * pending" from "Claude Code never listed a single server" (nothing loaded — usually not logged in). */
export class DiscoveryTimeoutError extends Error {
  constructor(readonly servers: ConnectorServer[]) { super("Timed out waiting for connector discovery"); }
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positiveTimeout(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Timeout must be a positive finite number");
  return value;
}
function spawnClaude(runtime: Runtime, path: string, cwd: string): Promise<Proc> {
  return runtime.spawn([
    path, "--print", "--verbose",
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--no-session-persistence", "--setting-sources", "",
    "--settings", '{"disableAllHooks":true}', "--tools", "",
    "--permission-mode", "dontAsk", "--no-chrome",
  ], { cwd, env: childEnv() });
}

/** Client for Claude Code's internal control protocol (tested on 2.1.263).
 * Connects using Claude Code's existing login. Sends control messages only.
 */
export class ClaudeConnectors {
  private readonly pending = new Map<string, Pending>();
  private readonly counts: Record<string, number> = {};
  private readonly reading: Promise<void>;
  private readonly draining: Promise<void>;
  private closedError?: Error;
  private closing?: Promise<void>;
  private readonly schemaAbort = new AbortController();
  private schemaCache?: Map<string, ToolSchema>;
  private schemaCapture?: Promise<Map<string, ToolSchema>>;

  private constructor(
    private readonly proc: Proc,
    private readonly requestTimeoutMs: number,
    private readonly discoveryTimeoutMs: number,
    private readonly schemaOptions: { claudePath: string; cwd: string; timeoutMs: number; discoveryTimeoutMs: number; runtime: Runtime },
    private readonly ownedDirectory?: string,
  ) {
    // Claude Code never keeps a program from exiting: a request waiting for its answer keeps it running through its
    // timeout timer, and Claude Code is stopped when the program exits.
    proc.unref();
    process.once("exit", this.stopOnExit);
    this.reading = this.readStdout();
    this.draining = (async () => {
      // Do not print or retain diagnostic output that could contain credentials.
      for await (const _chunk of proc.stderr) { /* discard */ }
    })().catch(() => {});
  }

  static async connect(options: ClientOptions = {}): Promise<ClaudeConnectors> {
    const timeout = positiveTimeout(options.requestTimeoutMs ?? 35_000);
    const discoveryTimeout = positiveTimeout(options.discoveryTimeoutMs ?? 30_000);
    const schemaTimeout = positiveTimeout(options.schemaTimeoutMs ?? 45_000);
    const ownedDirectory = options.cwd ? undefined : await mkdtemp(join(tmpdir(), "claude-connectors-"));
    let client: ClaudeConnectors | undefined;
    try {
      // Bun run prepends node_modules/.bin to PATH; prefer the native install
      // used by the original probe instead of an older npm-installed binary.
      const claudePath = options.claudePath ?? findClaude();
      const cwd = options.cwd ?? ownedDirectory!;
      const runtime = options.runtime ?? detected;
      const proc = await spawnClaude(runtime, claudePath, cwd);
      client = new ClaudeConnectors(proc, timeout, discoveryTimeout,
        { claudePath, cwd, timeoutMs: schemaTimeout, discoveryTimeoutMs: discoveryTimeout, runtime }, ownedDirectory);
      await client.request({ subtype: "initialize" });
      return client;
    } catch (error) {
      if (client) await client.close();
      else if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  get messageTypes(): Readonly<Record<string, number>> { return { ...this.counts }; }

  /** Closed, or Claude Code exited: no request will be answered. */
  get closed(): boolean { return this.closedError !== undefined; }

  /** Sends a control request. Never retries calls automatically. */
  async request<T = Record<string, unknown>>(
    request: ControlRequest, options: { timeoutMs?: number } = {},
  ): Promise<T> {
    // Closed or exited: this request is never sent, so a write records it as not sent.
    if (this.closedError) throw markNotSent(new Error(this.closedError.message));
    const timeoutMs = positiveTimeout(options.timeoutMs ?? this.requestTimeoutMs);
    const requestId = crypto.randomUUID();
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        // Best effort cancellation: a timeout does not prove the tool didn't run.
        try { this.send({ type: "control_cancel_request", request_id: requestId }); } catch { /* exited */ }
        reject(new Error(`Timed out waiting for ${request.subtype}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({ type: "control_request", request_id: requestId, request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
    return response as T;
  }

  /** Current status, including connectors that need authentication or failed. */
  async listServers(options: { timeoutMs?: number } = {}): Promise<ConnectorServer[]> {
    const data = await this.request({ subtype: "mcp_status" }, options);
    if (!Array.isArray(data.mcpServers)) throw new Error("Invalid mcp_status response");
    return data.mcpServers.map(value => {
      if (!record(value) || typeof value.name !== "string" || typeof value.status !== "string") {
        throw new Error("Invalid MCP server status");
      }
      return {
        name: value.name, status: value.status,
        scope: typeof value.scope === "string" ? value.scope : undefined,
        transport: record(value.config) && typeof value.config.type === "string" ? value.config.type : undefined,
        error: typeof value.error === "string" ? value.error : undefined,
        config: record(value.config) ? value.config : undefined,
        tools: Array.isArray(value.tools) ? value.tools.filter(tool => record(tool) && typeof tool.name === "string") as ToolMetadata[] : [],
      };
    });
  }

  /** Poll until the named servers (or, with none named, every server) have left `pending`.
   * Waiting only for the connectors a call needs saves 1–2 s (Datadog settles last). */
  async waitForServers(names?: string[]): Promise<ConnectorServer[]> {
    const deadline = Date.now() + this.discoveryTimeoutMs;
    let servers: ConnectorServer[] = [];
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DiscoveryTimeoutError(servers);
      try {
        servers = await this.listServers({ timeoutMs: Math.min(this.requestTimeoutMs, remaining) });
      } catch (error) {
        // A status request cut short by the deadline is the same timeout, not a protocol fault.
        if (Date.now() >= deadline) throw new DiscoveryTimeoutError(servers);
        throw error;
      }
      // Initialization can finish before the connector configuration is loaded.
      // An empty first snapshot is not evidence that discovery is complete.
      const settled = servers.length > 0 && !servers.some(server => server.status === "pending");
      if (settled) return servers;
      if (names?.length && names.every(name => servers.some(server => server.name === name && server.status !== "pending"))) return servers;
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  /** Wait for discovery and optionally enrich tools with cached model-facing schemas.
   * Schema capture uses a separate child and a rejecting loopback model endpoint.
   */
  listTools(options: ListToolsOptions & { includeSchemas: true }): Promise<ConnectorToolWithSchema[]>;
  listTools(options?: ListToolsOptions): Promise<ConnectorTool[]>;
  async listTools(options: ListToolsOptions = {}): Promise<ConnectorTool[]> {
    if (options.refreshSchemas && !options.includeSchemas) throw new Error("refreshSchemas requires includeSchemas");
    const servers = await this.waitForServers(options.servers);
    const normalize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const tools = servers.filter(server => server.status === "connected").flatMap(server =>
      server.tools.map(tool => ({
        ...tool, serverName: server.name, toolName: tool.name,
        name: `mcp__${normalize(server.name)}__${normalize(tool.name)}`,
      })),
    );
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
      throw new Error("Connector tool names collide after normalization");
    }
    if (!options.includeSchemas) return tools;
    if (!tools.length) return [];
    const schemas = await this.getSchemas(options.refreshSchemas ?? false);
    if (schemas.size !== tools.length || tools.some(tool => !schemas.has(tool.name))) {
      this.schemaCache = undefined;
      throw new Error("Connector tools changed since schema capture; retry schema discovery");
    }
    return tools.map(tool => ({ ...tool, ...structuredClone(schemas.get(tool.name)!) }));
  }

  private getSchemas(refresh: boolean): Promise<Map<string, ToolSchema>> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.schemaCapture) return this.schemaCapture;
    if (!refresh && this.schemaCache) return Promise.resolve(this.schemaCache);
    this.schemaCache = undefined;
    this.schemaCapture = captureConnectorSchemas({ ...this.schemaOptions, signal: this.schemaAbort.signal })
      .then(({ schemas }) => {
        if (this.closedError) throw this.closedError;
        return this.schemaCache = new Map(schemas.map(schema => [schema.name, schema]));
      }).finally(() => { this.schemaCapture = undefined; });
    return this.schemaCapture;
  }

  callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<ToolResult<T>> {
    return this.request<ToolResult<T>>({ subtype: "mcp_call", tool: name, arguments: args });
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private readonly stopOnExit = () => { if (this.proc.exitCode === null) this.proc.kill("SIGTERM"); };

  private async shutdown() {
    process.removeListener("exit", this.stopOnExit);
    this.fail(new Error("Claude connector client is closed"));
    if (this.proc.exitCode === null) this.proc.kill("SIGTERM");
    const forceKill = setTimeout(() => this.proc.kill("SIGKILL"), 5_000);
    try {
      await this.proc.exited;
      await Promise.all([this.reading, this.draining, this.schemaCapture?.catch(() => {})]);
    } finally {
      clearTimeout(forceKill);
      if (this.ownedDirectory) await rm(this.ownedDirectory, { recursive: true, force: true });
    }
  }

  private send(message: object) {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
    this.proc.stdin.flush();
  }

  private fail(error: Error) {
    this.closedError ??= error;
    this.schemaAbort.abort(this.closedError);
    this.schemaCache = undefined;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.closedError);
    }
    this.pending.clear();
  }

  private receive(line: string) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!record(message) || typeof message.type !== "string") return;
    this.counts[message.type] = (this.counts[message.type] ?? 0) + 1;
    if (message.type === "control_request") {
      this.send({ type: "control_response", response: {
        subtype: "error", request_id: message.request_id,
        error: "Client does not service host requests",
      } });
    } else if (message.type === "control_response" && record(message.response)) {
      const response = message.response;
      if (typeof response.request_id !== "string") return;
      const waiter = this.pending.get(response.request_id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(response.request_id);
      if (response.subtype === "error") waiter.reject(new Error(String(response.error ?? "Control request failed")));
      else if (response.subtype !== "success") waiter.reject(new Error("Invalid control response subtype"));
      else waiter.resolve(record(response.response) ? response.response : {});
    }
  }

  private async readStdout() {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          this.receive(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) this.receive(buffer);
      this.fail(new Error("Claude Code closed stdout"));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
