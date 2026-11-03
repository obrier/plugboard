import { parseArgs } from "node:util";
import { AxiError } from "axi-sdk-js";
import type { ClaudeConnectors } from "./bridge/client";
import { connect, costGuard } from "./claude";
import { EXIT, fail, retryAfterMs, type Code } from "./errors";
import { invoke, parseDeadline, prepare, profileName, requireConnected, requireManifest, requireTool, type Prepared } from "./call";
import { parseList, shape, unwrap } from "./output";
import { decide, loadPolicy } from "./policy";

type Line = { id?: unknown; connector?: unknown; tool?: unknown; args?: unknown; select?: unknown; where?: unknown; items?: unknown; deadline?: unknown };
type Task = { id: unknown; index: number; p: Prepared; deadline: number; shape: Parameters<typeof shape>[1]; attempts: number };
type Out = { id: unknown; ok: boolean; ms?: number; result?: unknown; error?: { code: Code; message: string; retryable: boolean; attempts?: number } };

const errorOf = (error: unknown) => ({
  code: (error instanceof AxiError ? error.code : "UPSTREAM_ERROR") as Code,
  message: error instanceof Error ? error.message : String(error),
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type BatchOptions = { profile: string; concurrency: number; perConnector: number; ordered: boolean; budgetMs: number };
export type Client = Pick<ClaudeConnectors, "request" | "waitForServers" | "close">;

/** JSONL in → JSONL out on one client. Reads only; each line fails on its own. */
export async function runBatch(input: string, o: BatchOptions, emit: (line: string) => void, makeClient: () => Promise<Client>, backoffMs = [1000, 4000]): Promise<number> {
  const policy = loadPolicy();
  const outputs: (Out | undefined)[] = [];
  let failed = 0;
  let next = 0; // ordered mode: index of the next line to print
  const done = (index: number, out: Out) => {
    if (!out.ok) failed++;
    outputs[index] = out;
    if (!o.ordered) return emit(JSON.stringify(out));
    while (outputs[next] !== undefined) emit(JSON.stringify(outputs[next++]));
  };

  const tasks: Task[] = [];
  const lines = input.split("\n").map(l => l.trim()).filter(Boolean);
  lines.forEach((text, index) => {
    let line: Line = {};
    try {
      line = JSON.parse(text);
      if (!line || typeof line !== "object" || Array.isArray(line)) throw new Error("line is not a JSON object");
      if (typeof line.connector !== "string" || typeof line.tool !== "string") throw fail("VALIDATION_ERROR", "connector and tool are required strings");
      if (line.args !== undefined && (typeof line.args !== "object" || line.args === null || Array.isArray(line.args))) throw fail("VALIDATION_ERROR", "args must be an object");
      const manifest = requireManifest(policy, line.connector);
      const tool = requireTool(manifest, line.tool);
      const p = prepare(policy, manifest, tool, (line.args ?? {}) as Record<string, unknown>, false);
      if (p.cls === "write") throw fail("POLICY_DENIED", `${manifest.id}:${tool.name} is a write tool; batch runs reads only`);
      decide(policy, o.profile, manifest.id, tool, false);
      tasks.push({ id: line.id ?? index, index, p, deadline: parseDeadline(line.deadline), attempts: 0, shape: {
        select: Array.isArray(line.select) ? line.select.map(String) : parseList(line.select as string | undefined),
        where: line.where as string | undefined, items: line.items as string | undefined } });
    } catch (error) {
      const e = errorOf(error);
      done(index, { id: line.id ?? index, ok: false, error: { ...e, code: e.code === "UPSTREAM_ERROR" ? "VALIDATION_ERROR" : e.code, retryable: false } });
    }
  });
  if (!tasks.length) return lines.length && failed ? EXIT.PARTIAL : EXIT.OK;

  const failAll = (list: Task[], code: Code, message: string) => { for (const t of list.splice(0)) done(t.index, { id: t.id, ok: false, error: { code, message, retryable: false } }); };
  let client: Client;
  try { client = await makeClient(); } catch (error) { failAll(tasks, "BRIDGE_BROKEN", errorOf(error).message); return EXIT.BRIDGE_BROKEN; }

  let broken = false;
  try {
    const names = [...new Set(tasks.map(t => t.p.manifest.connectorName))];
    const blind = new Map<string, string>(); // connector name → reason: the rest of its lines fail fast
    try {
      const servers = await client.waitForServers(names);
      for (const t of tasks) if (!blind.has(t.p.manifest.connectorName)) {
        try { requireConnected(servers, t.p.manifest); } catch (error) { blind.set(t.p.manifest.connectorName, errorOf(error).message); }
      }
    } catch (error) { failAll(tasks, "BRIDGE_BROKEN", errorOf(error).message); return EXIT.BRIDGE_BROKEN; }

    const queue = [...tasks];
    const active = new Map<string, number>();
    const caps = new Map<string, number>();
    let running = 0;
    const budgetEnd = Date.now() + o.budgetMs;
    await new Promise<void>(resolve => {
      const pump = () => {
        if (broken) failAll(queue, "BRIDGE_BROKEN", "Bridge failed during the batch");
        if (Date.now() > budgetEnd) failAll(queue, "TIMEOUT", "Batch budget exceeded");
        for (let i = 0; i < queue.length && running < o.concurrency; i++) {
          const t = queue[i]!;
          const name = t.p.manifest.connectorName;
          if (blind.has(name)) { queue.splice(i--, 1); done(t.index, { id: t.id, ok: false, error: { code: "AUTH_REQUIRED", message: blind.get(name)!, retryable: false } }); continue; }
          if ((active.get(name) ?? 0) >= (caps.get(name) ?? o.perConnector)) continue;
          queue.splice(i--, 1);
          running++;
          active.set(name, (active.get(name) ?? 0) + 1);
          void run(t).finally(() => { running--; active.set(name, active.get(name)! - 1); pump(); });
        }
        if (!running && !queue.length) resolve();
      };
      const run = async (t: Task) => {
        const started = Date.now();
        t.attempts++;
        try {
          const raw = await invoke(client, t.p, t.deadline);
          done(t.index, { id: t.id, ok: true, ms: Date.now() - started, result: shape(unwrap(raw), t.shape) });
        } catch (error) {
          const e = errorOf(error);
          const name = t.p.manifest.connectorName;
          if (e.code === "BRIDGE_BROKEN") broken = true;
          if (e.code === "AUTH_REQUIRED") blind.set(name, e.message);
          const again = (e.code === "RATE_LIMITED" && t.attempts < 3) || (e.code === "TIMEOUT" && t.attempts < 2);
          if (again && !broken) {
            if (e.code === "RATE_LIMITED") {
              caps.set(name, 1);
              await sleep(retryAfterMs(e.message) ?? backoffMs[t.attempts - 1]! * (1 + Math.random() * 0.2));
            }
            queue.push(t);
            return;
          }
          done(t.index, { id: t.id, ok: false, ms: Date.now() - started, error: { ...e, retryable: e.code === "RATE_LIMITED" || e.code === "TIMEOUT", attempts: t.attempts } });
        }
      };
      pump();
    });
    if (broken) return EXIT.BRIDGE_BROKEN;
    try { await costGuard(client); } catch (error) {
      const e = errorOf(error);
      emit(JSON.stringify({ id: null, ok: false, error: { ...e, retryable: false } }));
      return EXIT.COST_GUARD;
    }
    return failed ? EXIT.PARTIAL : EXIT.OK;
  } finally { await client.close(); }
}

export async function batchCommand(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      as: { type: "string" }, concurrency: { type: "string" }, ordered: { type: "boolean" }, budget: { type: "string" },
    } }));
  } catch (error) { throw fail("VALIDATION_ERROR", (error as Error).message, ["usage: connectors-axi batch [--as <profile>] [--concurrency 4] [--ordered] [--budget 5m] < calls.jsonl"]); }
  const policy = loadPolicy();
  const concurrency = values.concurrency === undefined ? policy.limits.concurrency : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw fail("VALIDATION_ERROR", "--concurrency must be a positive whole number");
  const input = await Bun.stdin.text();
  return runBatch(input, {
    profile: profileName(values as Record<string, string>), concurrency, perConnector: policy.limits.perConnector,
    ordered: values.ordered === true, budgetMs: parseDeadline(values.budget, 300_000),
  }, line => process.stdout.write(`${line}\n`), () => connect(policy));
}
