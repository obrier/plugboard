import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { encode } from "@toon-format/toon";
import { connectClaude } from "./claude";
import { EXIT, fail, type Code, type PlugboardError } from "./errors";
import { parseDeadline, profileName } from "./call";
import { callBatch, type BatchLine, type OpenSession } from "./core";
import { DirectSession, resolveTransport } from "./direct";
import { fileOf, itemCount, parseList, shape } from "./output";
import { newRun, writePrivate } from "./results";
import { loadPolicy } from "./policy";

type Failure = { code: Code; message: string; help?: string[] };
export type Out = { id: unknown; ok: boolean; ms?: number; result?: unknown; error?: Failure & { retryable: boolean; attempts?: number } };
/** A JSONL line as the CLI takes it: a call, a deadline and how to shape its result. */
type CliLine = BatchLine & { shape: Parameters<typeof shape>[1] };

export type BatchOptions = { profile: string; concurrency: number; perConnector: number; ordered: boolean; budgetMs: number };

/** A JSONL line as a call: its deadline and shape parsed inside the batch, so a bad one fails that line under its id. */
function toLine(raw: Record<string, unknown>): CliLine {
  return {
    id: raw.id, connector: raw.connector as string, tool: raw.tool as string, args: raw.args as Record<string, unknown> | undefined,
    timeoutMs: parseDeadline(raw.deadline as string | undefined),
    shape: { select: Array.isArray(raw.select) ? raw.select.map(String) : parseList(raw.select as string | undefined), where: raw.where as string | undefined, items: raw.items as string | undefined },
  };
}

/** Text lines as they arrive, each parsed as JSON; a blank line is skipped, one that isn't JSON is its line's failure. */
async function* jsonLines(texts: AsyncIterable<string> | Iterable<string>): AsyncGenerator<Record<string, unknown> | PlugboardError> {
  for await (const text of texts) {
    if (!text.trim()) continue;
    try { yield JSON.parse(text); } catch (error) { yield fail("VALIDATION_ERROR", `Not JSON: ${(error as Error).message}`); }
  }
}

/** JSONL in → one result per line out, through the core's batch, as lines arrive. Reads only; each line fails on its own. */
export async function runBatch(texts: AsyncIterable<string> | Iterable<string>, o: BatchOptions, emit: (out: Out) => void, open: OpenSession): Promise<number> {
  let failed = false;
  let stop: Code | undefined; // the session broke, or a model was reached: the batch's exit code
  for await (const r of callBatch(() => open, loadPolicy(), jsonLines(texts), o, toLine)) {
    if (r.ok) { emit({ id: r.id, ok: true, ms: r.ms, result: shape(r.value, r.line.shape) }); continue; }
    failed = true;
    const code = r.error.code as Code;
    if (code === "UNREACHABLE" || code === "COST_GUARD") stop ??= code;
    emit({ id: r.id, ok: false, ...(r.ms !== undefined ? { ms: r.ms } : {}), error: {
      code, message: r.error.message, ...(r.error.hints.length ? { help: r.error.hints } : {}), retryable: r.retryable, ...(r.attempts ? { attempts: r.attempts } : {}) } });
  }
  return stop ? EXIT[stop] : failed ? EXIT.PARTIAL : EXIT.OK;
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
  const rows = outs.map(out => {
    if (!out.ok) return { out, row: { id: String(out.id ?? ""), ok: false, ms: out.ms ?? null, items: null, tokens: null, file: null as string | null } };
    const { ext, text } = fileOf(out.result);
    let file: string | null = fileName(out.id, ext, used);
    try { dir ??= newRun("b"); writePrivate(dir, file, text); } catch (error) { writeError ??= (error as Error).message; file = null; }
    return { out, row: { id: String(out.id), ok: true, ms: out.ms ?? null, items: itemCount(out.result) ?? null, tokens: tokens(text.length), file } };
  });
  const errors = rows.filter(r => !r.out.ok).map(r => ({ id: r.row.id, code: r.out.error!.code, message: r.out.error!.message }));
  const head = { run: dir ?? "", results: rows.map(r => r.row), ...(errors.length ? { errors } : {}) };
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
  const options = {
    profile: profileName(values as Record<string, string>), concurrency, perConnector: policy.limits.perConnector,
    ordered: values.ordered === true || axi, budgetMs: parseDeadline(values.budget, 300_000),
  };
  // One session for the batch, taking each connector on as its first line comes, as the library's does.
  const session = new DirectSession([], () => connectClaude(policy), undefined, { transport: resolveTransport(policy) });
  const open: OpenSession = async manifest => { session.use([manifest]); return session; };
  const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity }); // stdin line by line, as it arrives
  try {
    if (!axi) return await runBatch(stdin, options, out => process.stdout.write(`${JSON.stringify(out)}\n`), open);
    const outs: Out[] = [];
    const code = await runBatch(stdin, options, out => outs.push(out), open);
    process.stdout.write(`${encode(axiSummary(outs, values.inline as string | undefined))}\n`);
    return code;
  } finally {
    stdin.close();
    await session.close();
  }
}
