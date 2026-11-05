// The safeguards every caller goes through: the CLI and the library alike. A read is decided by the
// policy before a session opens; a write is refused, replayed or audited here, never by the caller.
import { createHash } from "node:crypto";
import { viaOf, type Via } from "./direct";
import { appendAudit, claimKey, keyState, readAudit, type AuditEntry } from "./audit";
import type { ClaudeConnectors, ConnectorServer } from "./bridge/client";
import type { Manifest } from "./cache";
import { payloadHash, prepare, requireManifest, requireTool, type Prepared } from "./prepare";
import { costGuard } from "./claude";
import { linkSignals } from "./signals";
import { asPlugboardError, classify as classifyError, fail, PlugboardError, retryAfterMs, wasNotSent, type Code } from "./errors";
import { errorText, unwrap } from "./unwrap";
import { classify, decide, profileFor, type Policy } from "./policy";

import { BIN, requireConnected } from "./connected";
export { BIN, requireConnected };
/** What the core needs of a session; opened only once a call is allowed, for the connector the call names (a shared
 * session takes it on then). */
export type Session = Pick<ClaudeConnectors, "request" | "waitForServers">;
export type OpenSession = (manifest: Manifest) => Promise<Session>;

export async function invoke(client: Pick<ClaudeConnectors, "request">, p: Prepared, deadlineMs: number, signal?: AbortSignal) {
  let result: Record<string, any>;
  try {
    result = await client.request({ subtype: "mcp_call", tool: p.tool.sourceName, arguments: p.args }, { timeoutMs: deadlineMs, signal });
  } catch (error) {
    if (error instanceof PlugboardError) throw error; // a session that already knows what failed (the direct path) keeps its code
    const message = (error as Error).message;
    throw fail(classifyError(message), message);
  }
  if (result.isError === true) {
    const message = errorText(result);
    throw fail(classifyError(message), message);
  }
  return result;
}

/** An id worth keeping as sent_ref: Slack ts, a message or event id, a permalink. */
export function refOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["ts", "message_ts", "messageId", "id", "eventId", "threadId", "permalink"]) {
    const v = (value as any)[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  for (const v of Object.values(value)) if (v && typeof v === "object" && !Array.isArray(v)) { const r = refOf(v); if (r) return r; }
  return undefined;
}

/** A call as a caller asks for it. The core resolves the tool from the cache and validates and hashes the
 * args itself, so what the policy judges, what was approved and what is sent are always the same call. */
export type CallRequest = { connector: string; tool: string; args?: Record<string, unknown> };

/** The tool's own idempotency_key, when the caller left it to the write key. */
const keyFills = (tool: Prepared["tool"], args: Record<string, unknown> | undefined) =>
  "idempotency_key" in (tool.inputSchema.properties ?? {}) && args?.idempotency_key === undefined ? "idempotency_key" as const : undefined;

function mint(policy: Policy, req: CallRequest, key?: string): Prepared {
  const manifest = requireManifest(policy, req.connector);
  const tool = requireTool(manifest, req.tool);
  // Plain JSON once, before transforms, validation and the hash: the wire is JSON, so what is checked and
  // approved is exactly what is sent (no toJSON, getter or Date can change between the two).
  const args = JSON.parse(JSON.stringify(req.args ?? {})) as Record<string, unknown>;
  // A tool with its own idempotency_key gets the write key, so the service refuses a duplicate too. The key is
  // validated and sent, but stays out of the hash: the approval names the content, and the key is chosen at send
  // time (write(plan, { key })). One the caller wrote in the args is content, and hashed.
  const keyed = key !== undefined && keyFills(tool, args) !== undefined;
  if (keyed) args.idempotency_key = key;
  const p = prepare(policy, manifest, tool, args, classify(policy, manifest.id, tool) === "write");
  if (!keyed) return p;
  const { idempotency_key: _, ...content } = p.args;
  return { ...p, hash: payloadHash(manifest.id, tool.name, content, tool.sourceName) };
}

export type Plan = {
  connector: string; tool: string; class: string; destructive: boolean; profile: string; decision: string; hash: string;
  /** What the hash names: the args as sent, but for a parameter the write key fills (`keyFills`). */
  payload: Record<string, unknown>;
  /** A parameter the write key fills when the write is sent, whichever key that is: outside the payload and the hash. */
  keyFills?: "idempotency_key";
};
/** What a call would send and whether the profile allows it; a write's hash is what its approval names. */
export function planCall(policy: Policy, profile: string, req: CallRequest, key?: string): Plan {
  const p = mint(policy, req, key);
  let decision = "allowed";
  try { decide(policy, profile, p.manifest.id, p.tool, p.cls === "write"); } catch (error) { decision = `denied: ${(error as Error).message}`; }
  const fills = keyFills(p.tool, req.args);
  const payload = { ...p.args };
  if (fills) delete payload[fills];
  return { connector: p.manifest.id, tool: p.tool.name, class: p.cls, destructive: p.tool.annotations?.destructiveHint === true, profile, decision, hash: p.hash, payload, ...(fills ? { keyFills: fills } : {}) };
}

/** A call that failed may still have reached a model: its cost is checked as after a success. A session that isn't
 * zero-cost is COST_GUARD, naming the call's own failure; otherwise the call's error stands. */
async function failedCall(session: Session, error: unknown): Promise<never> {
  let guard: PlugboardError | undefined;
  try { await costGuard(session); } catch (e) { if (e instanceof PlugboardError && e.code === "COST_GUARD") guard = e; }
  if (guard) throw fail("COST_GUARD", `${guard.message} (the call itself failed: ${(error as Error).message})`, guard.hints);
  throw error;
}

/** `via`: the path that served the call, the connector proxy direct or Claude Code. */
export type ReadResult = { raw: Record<string, any>; value: unknown; via: Via };

/** One read: the profile must allow it, the connector must be connected, and the session must stay zero-cost. */
export async function callRead(open: OpenSession, policy: Policy, profile: string, req: CallRequest, deadlineMs: number, signal?: AbortSignal): Promise<ReadResult> {
  const p = mint(policy, req);
  decide(policy, profile, p.manifest.id, p.tool, false);
  stopIfCancelled(signal, "Read");
  const session = await beforeSend(open(p.manifest), signal, "Read");
  requireConnected(await beforeSend(session.waitForServers([p.manifest.connectorName]), signal, "Read"), p.manifest);
  const raw = await invoke(session, p, deadlineMs, signal).catch(error => failedCall(session, error));
  await costGuard(session);
  return { raw, value: unwrap(raw), via: viaOf(raw) };
}

/** An attempt with no outcome yet, still within its deadline (and a minute's grace): another write is running it.
 * An older one crashed or lost its answer: its outcome is unknown. */
function inFlight(last: AuditEntry | undefined) {
  if (last?.status !== "attempt") return false;
  const deadline = typeof last.deadline_ms === "number" ? last.deadline_ms : 30_000;
  return Date.now() - Date.parse(last.ts) < deadline + 60_000;
}

export type WriteRequest = { profile: string; key: string; expectHash: string; deadlineMs: number; signal?: AbortSignal };

/** A call cancelled before it started: nothing was opened or sent. */
function stopIfCancelled(signal: AbortSignal | undefined, what: string) {
  if (signal?.aborted) throw fail("TIMEOUT", `${what} cancelled before it started: nothing was sent`);
}

/** Waits for a step before the send (the session's start, its discovery), or stops at once when cancelled: nothing was
 * sent, and the step finishes on its own for the session's next call. */
function beforeSend<T>(step: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (!signal) return step;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(fail("TIMEOUT", `${what} cancelled before it was sent: nothing was sent`));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    step.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
export type WriteResult =
  | { replayed: true; key: string; ref: string | null; at?: string }
  | { replayed: false; key: string; ref: string | null; raw: Record<string, any>; value: unknown; via: Via };

/** One write, never retried: the profile must allow it, the payload must be the approved one, and the
 * key names it once. Audited before the call, so a write that can't be audited is never sent. */
export async function callWrite(open: OpenSession, policy: Policy, call: CallRequest, req: WriteRequest): Promise<WriteResult> {
  const { profile, key, expectHash } = req;
  const p = mint(policy, call, key);
  if (process.env.CLAUDECODE && !profileFor(policy, profile).allowInAgent)
    throw fail("POLICY_DENIED", "Writes are refused inside a Claude Code session (CLAUDECODE is set)", ["Run the write from your own shell, or set allow_in_agent = true on its profile"]);
  decide(policy, profile, p.manifest.id, p.tool, true);
  if (!key) throw fail("VALIDATION_ERROR", "A write needs a key that names it", ["A key that names this one write, such as reply-42"]);
  if (expectHash !== p.hash) throw fail("POLICY_DENIED", `Payload hash ${p.hash} does not match the approved hash ${expectHash || "(missing)"}`, [
    "The approved payload changed, or was never approved: plan it again and approve the new hash",
  ]);
  const replayOrRefuse = ({ state, last }: { state: string; last?: AuditEntry }): WriteResult | undefined => {
    if (state === "ok") return { replayed: true, key, ref: (last?.ref as string | undefined) ?? null, at: last?.ts };
    if (state === "unknown" && inFlight(last))
      throw fail("WRITE_OUTCOME_UNKNOWN", `A write under key ${key} is in progress (process ${last!.pid})`, [
        "Wait for it to finish, then run the same write again: it replays the result",
      ]);
    if (state === "unknown") throw fail("WRITE_OUTCOME_UNKNOWN", `A write under key ${key} has no known outcome`, [
    `Check the destination by hand, then run \`${BIN} audit resolve ${key} --sent\` or \`--not-sent\``,
    ]);
    return undefined;
  };
  const seen = readAudit(); // the claim below loses to any attempt that lands after this read
  const early = replayOrRefuse(keyState(key, seen)); // no session for a key already sent or unresolved
  if (early) return early;

  stopIfCancelled(req.signal, `Write ${key}`);
  const session = await beforeSend(open(p.manifest), req.signal, `Write ${key}`);
  requireConnected(await beforeSend(session.waitForServers([p.manifest.connectorName]), req.signal, `Write ${key}`), p.manifest);
  stopIfCancelled(req.signal, `Write ${key}`); // still unclaimed: nothing to record
  // Re-checked and claimed in one step right before the call: a concurrent write under this key can't also send.
  let claim: ReturnType<typeof claimKey>;
  try {
    claim = claimKey(key, { key, profile, connector: p.manifest.id, tool: p.tool.name, payload_sha256: p.hash, status: "attempt", pid: process.pid, deadline_ms: req.deadlineMs }, seen.length);
  } catch (error) { // the audit log can't record the attempt: nothing is sent
    const e = asPlugboardError(error);
    throw fail(e.code as Code, `Write ${key} was not sent: ${e.message}`, e.hints);
  }
  if (!claim.claimed) {
    const lost = replayOrRefuse(claim);
    if (lost) return lost;
    // Lost while the key reads failed: a rival claimed it after this call's pre-check, then didn't send.
    const why = typeof claim.last?.message === "string" ? `: ${claim.last.message}` : claim.last?.status === "resolved-not-sent" ? " (resolved by hand as not sent)" : "";
    if (claim.state === "error") throw fail("UPSTREAM_ERROR", `A concurrent write under key ${key} didn't send${why}`, [
      "Nothing was sent by this call. Run the write again to retry",
    ]);
    throw fail("WRITE_OUTCOME_UNKNOWN", `A write under key ${key} is in progress`, ["Wait for it to finish, then run the same write again: it replays the result"]);
  }
  const started = Date.now();
  let raw: Record<string, any>;
  try {
    raw = await invoke(session, p, req.deadlineMs, req.signal);
  } catch (error) {
    const code = error instanceof PlugboardError ? error.code : "UPSTREAM_ERROR";
    if ((code === "TIMEOUT" || code === "UNREACHABLE") && !wasNotSent(error)) {
      appendAudit({ key, status: "unknown", code, ms: Date.now() - started });
      throw fail("WRITE_OUTCOME_UNKNOWN", `Write ${key} may or may not have happened: ${(error as Error).message}`, [
        `Check the destination by hand, then \`${BIN} audit resolve ${key} --sent|--not-sent\``,
      ]);
    }
    appendAudit({ key, status: "error", code, message: (error as Error).message.slice(0, 300), ms: Date.now() - started });
    return await failedCall(session, error).catch(e => {
      if (e instanceof PlugboardError && e.code === "COST_GUARD") appendAudit({ key, status: "cost-guard", message: e.message });
      throw e;
    });
  }
  const value = unwrap(raw);
  const ref = refOf(value) ?? null;
  appendAudit({ key, status: "ok", ms: Date.now() - started, result_sha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"), ...(ref ? { ref } : {}) });
  try { await costGuard(session); } catch (error) { appendAudit({ key, status: "cost-guard", message: (error as Error).message }); throw error; }
  return { replayed: false, key, ref, raw, value, via: viaOf(raw) };
}

/** A batch line: a call, as `call()` takes it, with an optional id (its input position by default). */
export type BatchLine = CallRequest & { id?: unknown; profile?: string; timeoutMs?: number; signal?: AbortSignal };
export type BatchSettings = {
  /** The profile a line is judged by unless it names one. */
  profile: string;
  concurrency: number;
  perConnector: number;
  /** Results in input order; completion order otherwise. */
  ordered: boolean;
  /** Once spent, lines not yet started fail with TIMEOUT, unsent. None by default. */
  budgetMs?: number;
  /** The waits before a rate-limited line's second and third attempts, when the error names none. */
  backoffMs?: number[];
};
type Attempts = { id: unknown; index: number; attempts: number; ms?: number };
export type BatchResult<L extends BatchLine = BatchLine> = Attempts & (
  | { ok: true; line: L; value: unknown; raw: Record<string, any>; via: Via }
  | { ok: false; error: PlugboardError; retryable: boolean });

/** Reads in, results out, as both arrive: a line's failure is its result. UNREACHABLE or COST_GUARD (or the budget)
 * fails the lines already taken in, unsent, and ends the batch without reading on; UNREACHABLE and COST_GUARD also
 * cancel the lines still running, which fail with it. Leaving the loop cancels them too. An input that throws: the
 * lines it gave finish and are delivered, then its error is thrown.
 * Reads only. It reads ahead at most `concurrency` lines it can't start yet. An item that is already an error (a
 * line its producer couldn't parse) is that line's failure; `toLine` turns a producer's own form into a line, its
 * failure that line's too, under the item's id. `open` gives the session for a line. */
export async function* callBatch<L extends BatchLine, I = L>(open: (line: L) => OpenSession, policy: Policy,
  items: Iterable<I | PlugboardError> | AsyncIterable<I | PlugboardError>, o: BatchSettings,
  toLine: (item: I) => L = item => item as unknown as L): AsyncGenerator<BatchResult<L>> {
  type Task = { line: L; id: unknown; index: number; name: string; attempts: number };
  const source = (async function* () { yield* items; })();
  const cancel = new AbortController(); // the loop was left
  const stopRunning = new AbortController(); // UNREACHABLE or COST_GUARD: the lines still running are cancelled
  const budgetEnd = o.budgetMs === undefined ? Infinity : Date.now() + o.budgetMs;
  const backoff = o.backoffMs ?? [1000, 4000];
  const queue: Task[] = [];
  const active = new Map<string, number>(); // connector name → lines running
  const caps = new Map<string, number>(); // connector name → its limit once rate-limited
  const blind = new Map<string, PlugboardError>(); // connector name → its auth failure: its other lines fail unsent
  const running = new Set<Promise<void>>();
  const out: BatchResult<L>[] = [];
  const held = new Map<number, BatchResult<L>>(); // ordered: results waiting for an earlier line's
  let next = 0, read = 0, pulling = false, ended = false, stop: PlugboardError | undefined;
  let producer: { error: unknown } | undefined; // the input threw: what it gave finishes first
  let wake: (() => void) | undefined;
  const signal = () => { const w = wake; wake = undefined; w?.(); };

  const emit = (result: BatchResult<L>) => {
    if (!o.ordered) out.push(result);
    else { held.set(result.index, result); while (held.has(next)) { out.push(held.get(next)!); held.delete(next++); } }
    signal();
  };
  const failLine = (t: Pick<Task, "id" | "index"> & { attempts?: number }, error: PlugboardError, extra: { retryable?: boolean; ms?: number } = {}) =>
    emit({ id: t.id, index: t.index, attempts: t.attempts ?? 0, ok: false, error, retryable: extra.retryable ?? false, ...(extra.ms !== undefined ? { ms: extra.ms } : {}) });
  const stopped = () => {
    if (!stop && Date.now() > budgetEnd) stop = fail("TIMEOUT", "Batch budget exceeded: not sent");
    return stop;
  };

  const intake = (raw: I | PlugboardError, index: number) => {
    let id: unknown = index;
    try {
      if (raw instanceof PlugboardError) throw raw;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("VALIDATION_ERROR", "A line is not an object: { connector, tool, args }");
      id = (raw as { id?: unknown }).id ?? index;
      const halt = stopped();
      if (halt) return failLine({ id, index }, halt);
      const item = toLine(raw);
      if (typeof item.connector !== "string" || typeof item.tool !== "string") throw fail("VALIDATION_ERROR", "connector and tool are required strings");
      if (item.args !== undefined && (typeof item.args !== "object" || item.args === null || Array.isArray(item.args))) throw fail("VALIDATION_ERROR", "args must be an object");
      if (item.timeoutMs !== undefined && !(typeof item.timeoutMs === "number" && item.timeoutMs > 0)) throw fail("VALIDATION_ERROR", "timeoutMs must be a positive number");
      // Checked as the line arrives, before it takes a place: the read itself checks again, through the core.
      const manifest = requireManifest(policy, item.connector);
      const tool = requireTool(manifest, item.tool);
      if (classify(policy, manifest.id, tool) === "write")
        throw fail("POLICY_DENIED", `${manifest.id}:${tool.name} is a write tool; a batch runs reads only`, ["Plan a write and send it on its own, with its approval"]);
      prepare(policy, manifest, tool, JSON.parse(JSON.stringify(item.args ?? {})), false);
      decide(policy, item.profile ?? o.profile, manifest.id, tool, false);
      queue.push({ line: item, id, index, name: manifest.connectorName, attempts: 0 });
    } catch (error) {
      const e = asPlugboardError(error, "VALIDATION_ERROR");
      failLine({ id, index }, e);
    }
  };

  const run = async (t: Task) => {
    const started = Date.now();
    t.attempts++;
    try {
      const { line } = t;
      const link = linkSignals([cancel.signal, stopRunning.signal, line.signal]);
      let read: ReadResult;
      try { // let go of the signals once the line is done, however it ends (its opener can throw before any promise)
        read = await callRead(open(line), policy, line.profile ?? o.profile, { connector: line.connector, tool: line.tool, args: line.args },
          line.timeoutMs ?? 30_000, link.signal);
      } finally { link.dispose(); }
      emit({ id: t.id, index: t.index, attempts: t.attempts, ms: Date.now() - started, ok: true, line, ...read });
    } catch (error) {
      if (cancel.signal.aborted) return; // left the loop: no one reads it
      let e = asPlugboardError(error, "UPSTREAM_ERROR");
      if (e.code === "UNREACHABLE" || e.code === "COST_GUARD") {
        if (!stop) { stop = fail(e.code, `Stopped: ${e.message}`, e.hints); stopRunning.abort(); }
      } else if (stopRunning.signal.aborted && e.code === "TIMEOUT") e = stop!; // cancelled by the stop: it fails with it
      if (e.code === "AUTH_REQUIRED") blind.set(t.name, e);
      const cancelled = t.line.signal?.aborted === true; // its caller's cancel: not retried
      const again = !cancelled && ((e.code === "RATE_LIMITED" && t.attempts < 3) || (e.code === "TIMEOUT" && t.attempts < 2));
      if (again && !stopped()) {
        if (e.code === "RATE_LIMITED") {
          caps.set(t.name, 1);
          await sleep(retryAfterMs(e.message) ?? backoff[t.attempts - 1]! * (1 + Math.random() * 0.2), cancel.signal);
        }
        queue.push(t);
        return;
      }
      failLine(t, e, { retryable: !cancelled && !stop && (e.code === "RATE_LIMITED" || e.code === "TIMEOUT"), ms: Date.now() - started });
    }
  };

  const pump = () => {
    const halt = stopped();
    if (halt) for (const t of queue.splice(0)) failLine(t, halt);
    for (let i = 0; i < queue.length && running.size < o.concurrency; i++) {
      const t = queue[i]!;
      const fault = blind.get(t.name);
      if (fault) { queue.splice(i--, 1); failLine(t, fault); continue; }
      if ((active.get(t.name) ?? 0) >= (caps.get(t.name) ?? o.perConnector)) continue;
      queue.splice(i--, 1);
      active.set(t.name, (active.get(t.name) ?? 0) + 1);
      const task: Promise<void> = run(t).finally(() => { running.delete(task); active.set(t.name, active.get(t.name)! - 1); signal(); });
      running.add(task);
    }
    // Read on while fewer than `concurrency` lines wait, to start or to be read (a result held for an earlier
    // line's, or not yet taken): a stopped batch reads no more.
    if (!pulling && !ended && !halt && queue.length + held.size + out.length < o.concurrency) {
      pulling = true;
      source.next().then(r => {
        pulling = false;
        if (r.done) ended = true; else intake(r.value, read++);
        signal();
      }, error => { pulling = false; ended = true; producer = { error }; signal(); });
    }
  };

  try {
    for (;;) {
      pump();
      if (out.length) { yield out.shift()!; continue; }
      if ((ended || stop) && !pulling && !queue.length && !running.size) {
        if (producer) throw producer.error;
        return;
      }
      await new Promise<void>(resolve => (wake = resolve));
    }
  } finally {
    cancel.abort();
    const closing = source.return(undefined).catch(() => {});
    if (!pulling) await closing; // a producer still working on its next line is left to finish on its own
    await Promise.allSettled(running);
  }
}

/** Waits ms, or until the signal aborts, whichever comes first; either way it stops listening. Its timer keeps the
 * program running: a retry is still to come. */
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});
