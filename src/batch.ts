import { parseArgs } from "node:util";
import type { Manifest } from "./cache";
import { encode } from "@toon-format/toon";
import type { ClaudeConnectors } from "./bridge/client";
import { connect, costGuard } from "./claude";
import { asPlugboardError, EXIT, fail, retryAfterMs, type Code } from "./errors";
import { parseDeadline, prepare, profileName, requireManifest, requireTool, type Prepared } from "./call";
import { callRead, requireConnected, type Session } from "./core";
import { fileOf, itemCount, parseList, shape } from "./output";
import { newRun, writePrivate } from "./results";
import { decide, loadPolicy } from "./policy";

type Line = { id?: unknown; connector?: unknown; tool?: unknown; args?: unknown; select?: unknown; where?: unknown; items?: unknown; deadline?: unknown };
type Task = { id: unknown; index: number; p: Prepared; raw: Record<string, unknown>; deadline: number; shape: Parameters<typeof shape>[1]; attempts: number };
type Failure = { code: Code; message: string; help?: string[] };
export type Out = { id: unknown; ok: boolean; ms?: number; result?: unknown; error?: Failure & { retryable: boolean; attempts?: number } };

/** An error as a batch line reports it, its hints kept. */
const errorOf = (error: unknown): Failure => {
  const e = asPlugboardError(error, "UPSTREAM_ERROR");
  return { code: e.code as Code, message: e.message, ...(e.hints.length ? { help: e.hints } : {}) };
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type BatchOptions = { profile: string; concurrency: number; perConnector: number; ordered: boolean; budgetMs: number };
export type Client = Pick<ClaudeConnectors, "request" | "waitForServers" | "close">;

/** JSONL in → one result per line out, on one client. Reads only; each line fails on its own. */
export async function runBatch(input: string, o: BatchOptions, emit: (out: Out) => void, makeClient: (needs: Manifest[]) => Promise<Client>, backoffMs = [1000, 4000]): Promise<number> {
  const policy = loadPolicy();
  const outputs: (Out | undefined)[] = [];
  let failed = 0;
  let next = 0; // ordered mode: index of the next line to print
  const done = (index: number, out: Out) => {
    if (!out.ok) failed++;
    outputs[index] = out;
    if (!o.ordered) return emit(out);
    while (outputs[next] !== undefined) emit(outputs[next++]!);
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
      tasks.push({ id: line.id ?? index, index, p, raw: (line.args ?? {}) as Record<string, unknown>, deadline: parseDeadline(line.deadline), attempts: 0, shape: {
        select: Array.isArray(line.select) ? line.select.map(String) : parseList(line.select as string | undefined),
        where: line.where as string | undefined, items: line.items as string | undefined } });
    } catch (error) {
      const e = errorOf(error);
      done(index, { id: line.id ?? index, ok: false, error: { ...e, code: e.code === "UPSTREAM_ERROR" ? "VALIDATION_ERROR" : e.code, retryable: false } });
    }
  });
  if (!tasks.length) return lines.length && failed ? EXIT.PARTIAL : EXIT.OK;

  const failAll = (list: Task[], failure: Failure) => { for (const t of list.splice(0)) done(t.index, { id: t.id, ok: false, error: { ...failure, retryable: false } }); };
  let client: Client;
  try { client = await makeClient(tasks.map(t => t.p.manifest)); } catch (error) {
    const e = asPlugboardError(error, "UNREACHABLE");
    failAll(tasks, errorOf(e));
    return e.exitCode;
  }

  let stopped: Failure | undefined; // a broken bridge, or a model reached: the rest of the batch fails with it
  try {
    const names = [...new Set(tasks.map(t => t.p.manifest.connectorName))];
    let servers: Awaited<ReturnType<Client["waitForServers"]>> = [];
    // One connection check for the whole batch: each line's read sees this snapshot, not a new discovery wait.
    const session: Session = { request: (req, opts) => client.request(req, opts), waitForServers: async () => servers };
    const blind = new Map<string, Failure>(); // connector name → its failure, hints kept: the rest of its lines fail fast
    try {
      servers = await client.waitForServers(names);
      for (const t of tasks) if (!blind.has(t.p.manifest.connectorName)) {
        try { requireConnected(servers, t.p.manifest); } catch (error) { blind.set(t.p.manifest.connectorName, errorOf(error)); }
      }
    } catch (error) { failAll(tasks, { ...errorOf(error), code: "UNREACHABLE" }); return EXIT.UNREACHABLE; }

    const queue = [...tasks];
    const active = new Map<string, number>();
    const caps = new Map<string, number>();
    let running = 0;
    const budgetEnd = Date.now() + o.budgetMs;
    await new Promise<void>(resolve => {
      const pump = () => {
        if (stopped) failAll(queue, stopped);
        if (Date.now() > budgetEnd) failAll(queue, { code: "TIMEOUT", message: "Batch budget exceeded" });
        for (let i = 0; i < queue.length && running < o.concurrency; i++) {
          const t = queue[i]!;
          const name = t.p.manifest.connectorName;
          if (blind.has(name)) { queue.splice(i--, 1); done(t.index, { id: t.id, ok: false, error: { ...blind.get(name)!, code: "AUTH_REQUIRED", retryable: false } }); continue; }
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
          const request = { connector: t.p.manifest.id, tool: t.p.tool.name, args: t.raw };
          const { value } = await callRead(async () => session, policy, o.profile, request, t.deadline); // the core's read, as the CLI's
          done(t.index, { id: t.id, ok: true, ms: Date.now() - started, result: shape(value, t.shape) });
        } catch (error) {
          const e = errorOf(error);
          const name = t.p.manifest.connectorName;
          if (e.code === "UNREACHABLE") stopped ??= { code: "UNREACHABLE", message: "Bridge failed during the batch" };
          if (e.code === "COST_GUARD") stopped ??= { ...e, message: `Stopped: ${e.message}` };
          if (e.code === "AUTH_REQUIRED") blind.set(name, e);
          const again = (e.code === "RATE_LIMITED" && t.attempts < 3) || (e.code === "TIMEOUT" && t.attempts < 2);
          if (again && !stopped) {
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
    if (stopped) return EXIT[stopped.code];
    try { await costGuard(client); } catch (error) {
      const e = errorOf(error);
      emit({ id: null, ok: false, error: { ...e, retryable: false } });
      return EXIT.COST_GUARD;
    }
    return failed ? EXIT.PARTIAL : EXIT.OK;
  } finally { await client.close(); }
}

const INLINE_BUDGET = 15_000; // characters: well under the 30,000 at which Claude Code saves Bash output to a file
/** An estimate: about 2.4 characters per token on connector results. */
function tokens(chars: number) {
  const n = Math.ceil(chars / 2.4);
  return n < 1000 ? `~${n}` : `~${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
}

/** A file name for an id: safe on every OS, unique even where names ignore case. */
function fileName(id: unknown, ext: string, used: Set<string>) {
  let base = String(id).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 60) || "result";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base.split(".")[0]!)) base = `_${base}`; // reserved on Windows, whatever the extension
  let name = `${base}.${ext}`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}.${ext}`;
  used.add(name.toLowerCase());
  return name;
}

/** --axi: every result in full in its own private file; a manifest in input order; small results inline, so
 * the whole output, manifest included, stays within a budget. `inline` is "none", "all" or a list of ids.
 * A result that can't be written goes inline whatever its size: nothing is lost. */
export function axiSummary(outs: Out[], inline?: string) {
  let dir: string | undefined;
  let writeError: string | undefined;
  const used = new Set<string>();
  const batchError = outs.find(o => o.id === null && !o.ok)?.error; // the cost guard: about the whole run, not a line
  const rows = outs.filter(o => o.id !== null).map(out => {
    if (!out.ok) return { out, row: { id: String(out.id ?? ""), ok: false, ms: out.ms ?? null, items: null, tokens: null, file: null as string | null } };
    const { ext, text } = fileOf(out.result);
    let file: string | null = fileName(out.id, ext, used);
    try { dir ??= newRun("b"); writePrivate(dir, file, text); } catch (error) { writeError ??= (error as Error).message; file = null; }
    return { out, row: { id: String(out.id), ok: true, ms: out.ms ?? null, items: itemCount(out.result) ?? null, tokens: tokens(text.length), file } };
  });
  const errors = rows.filter(r => !r.out.ok).map(r => ({ id: r.row.id, code: r.out.error!.code, message: r.out.error!.message }));
  const head = { run: dir ?? "", results: rows.map(r => r.row), ...(errors.length ? { errors } : {}), ...(batchError ? { error: { code: batchError.code, message: batchError.message } } : {}) };
  const wanted = inline && inline !== "all" && inline !== "none" ? new Set(parseList(inline)) : undefined;
  let budget = inline === "all" ? Infinity : inline === "none" ? 0 : INLINE_BUDGET - encode(head).length;
  const inlined: [string, unknown][] = [];
  const keys = new Set<string>();
  let skipped = 0, skippedChars = 0;
  for (const r of rows) if (r.out.ok) {
    let key = r.row.id;
    for (let n = 2; keys.has(key); n++) key = `${r.row.id}-${n}`; // a repeated id: never overwrite another inline result
    const size = encode({ inline: Object.fromEntries([[key, r.out.result]]) }).length - "inline:\n".length; // as printed, nested
    const take = r.row.file === null || (wanted ? wanted.has(r.row.id) : size <= budget);
    if (!take) { skipped++; skippedChars += size; continue; }
    if (!wanted && r.row.file !== null) budget -= size;
    keys.add(key);
    inlined.push([key, r.out.result]);
  }
  return {
    ...head,
    ...(inlined.length ? { inline: Object.fromEntries(inlined) } : {}),
    help: [
      ...new Set(outs.flatMap(o => o.error?.help ?? [])), // what failed lines say to do, once each
      ...(writeError ? [`Some results were not written to disk (${writeError}): they are inline in full`] : []),
      ...(skipped ? [`${skipped} result(s) not inlined (${tokens(skippedChars)} tokens): read the files you need`] : []),
      ...(dir ? [`grep -l <word> "${dir}"/* finds a word across results; files are private and removed after a day`] : []),
    ],
  };
}

export async function batchCommand(argv: string[], axi = false): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      as: { type: "string" }, concurrency: { type: "string" }, ordered: { type: "boolean" }, budget: { type: "string" }, inline: { type: "string" },
    } }));
  } catch (error) { throw fail("VALIDATION_ERROR", (error as Error).message, ["usage: plugboard batch [--as <profile>] [--concurrency 4] [--ordered] [--budget 5m] [--axi [--inline none|all|id,id]] < calls.jsonl"]); }
  if (values.inline !== undefined && !axi) throw fail("VALIDATION_ERROR", "--inline needs --axi");
  const policy = loadPolicy();
  const concurrency = values.concurrency === undefined ? policy.limits.concurrency : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw fail("VALIDATION_ERROR", "--concurrency must be a positive whole number");
  const input = await Bun.stdin.text();
  const options = {
    profile: profileName(values as Record<string, string>), concurrency, perConnector: policy.limits.perConnector,
    ordered: values.ordered === true || axi, budgetMs: parseDeadline(values.budget, 300_000),
  };
  if (!axi) return runBatch(input, options, out => process.stdout.write(`${JSON.stringify(out)}\n`), needs => connect(policy, needs));
  const outs: Out[] = [];
  const code = await runBatch(input, options, out => outs.push(out), needs => connect(policy, needs));
  process.stdout.write(`${encode(axiSummary(outs, values.inline as string | undefined))}\n`);
  return code;
}
