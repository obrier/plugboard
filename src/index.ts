// @obrier/plugboard: claude.ai connector tools from code, with the CLI's safeguards (docs/design/library.md).
// The module functions are a default instance, created on first use; createPlugboard() makes another, with its
// own policy, profile, transport and session. Every call goes through the core, as the CLI's do.
import { connectClaude } from "./claude";
import { callBatch, callRead, callWrite, planCall, type Plan } from "./core";
import type { PlugboardError } from "./errors";
import { DirectSession, resolveTransport, type Transport, type Via } from "./direct";
import { fail } from "./errors";
import { requireManifest, requireTool } from "./prepare";
import { classify, loadPolicy, type Policy } from "./policy";

export { EXIT, PlugboardError, type Code } from "./errors";
export type { Transport, Via } from "./direct";

/** A call: the shape of a batch line, `{ connector, tool, args }`, with the call's options beside it. */
export type Call = {
  /** A connector ID or a policy alias. */
  connector: string;
  /** The tool's name, the CLI's short name, or its kebab form. */
  tool: string;
  args?: Record<string, unknown>;
  /** The policy profile that judges the call; the instance's by default. */
  profile?: string;
  /** The CLI's --deadline: 30 s by default. */
  timeoutMs?: number;
  /** Cancels the call: a read is dropped; a write cancelled after it was sent has an unknown outcome, as on a timeout. */
  signal?: AbortSignal;
  /** How the call reaches its connector; the narrowest setting wins: the call's, the instance's, PLUGBOARD_TRANSPORT, the policy's. */
  transport?: Transport;
};
/** A read's result: the value as the CLI prints it, the MCP result as the connector sent it, and the path that served it. */
export type Read = { value: unknown; raw: Record<string, unknown>; via: Via };
/** What a write would send and whether the profile allows it, with the request it was planned from: plain JSON. */
export type WritePlan = Plan & { request: { connector: string; tool: string; args: Record<string, unknown>; profile: string } };
export type WriteOptions = {
  key: string;
  /** The write profile it is sent under; the instance's by default. The plan's own profile is never trusted, as the
   * CLI's --as is the sender's: no hash covers it. */
  profile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  transport?: Transport;
};
/** Sent now, or already sent under this key before (nothing was called). */
export type Written =
  | { sent: true; key: string; ref: string | null; value: unknown; raw: Record<string, unknown>; via: Via }
  | { replayed: true; key: string; ref: string | null; at?: string };
/** A batch line: a call, with an id to tell its result by (its input position by default). */
export type BatchCall = Call & { id?: unknown };
export type BatchOptions = {
  /** Lines running at once: the policy's limits.concurrency (4) by default. */
  concurrency?: number;
  /** Lines running at once on one connector: the policy's limits.per_connector (2) by default. */
  perConnector?: number;
  /** Results in input order; completion order by default. */
  ordered?: boolean;
  /** Once spent, the lines not yet started fail with TIMEOUT, unsent. None by default. */
  budgetMs?: number;
};
/** A line's result: a failure is a result too, never an exception. */
export type BatchRead = { id: unknown; ok: true; value: unknown; raw: Record<string, unknown>; via: Via } | { id: unknown; ok: false; error: PlugboardError };
export type PlugboardOptions = {
  /** A policy file; PLUGBOARD_POLICY's, or the default location, otherwise. Read once, on first use. */
  policy?: string;
  /** The profile calls use unless they name one; PLUGBOARD_PROFILE, or "default", otherwise. */
  profile?: string;
  transport?: Transport;
};
export type Plugboard = {
  /** One read. A write tool is refused: plan it and send it with write(). */
  call(request: Call): Promise<Read>;
  /** A write (or a read) as it would be sent, with the hash its approval names. */
  plan(request: Omit<Call, "signal" | "timeoutMs" | "transport">): WritePlan;
  /** Sends an approved plan once under this key. Nothing in the plan is trusted: its request is planned again and
   * sent only if the hash still matches. */
  write(plan: WritePlan, options: WriteOptions): Promise<Written>;
  /** Reads, as they arrive, results as they come: UNREACHABLE or COST_GUARD fails the lines still to come and ends
   * it; leaving the loop cancels the lines still running. A write tool is refused for its line. */
  batch(lines: Iterable<BatchCall> | AsyncIterable<BatchCall>, options?: BatchOptions): AsyncGenerator<BatchRead, void, undefined>;
  /** Closes the instance's sessions now, rather than when idle. */
  close(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function createPlugboard(options: PlugboardOptions = {}): Plugboard {
  let policy: Policy | undefined;
  const loaded = () => (policy ??= loadPolicy(options.policy));
  const profileOf = (profile?: string) => profile ?? options.profile ?? process.env.PLUGBOARD_PROFILE ?? "default";
  // One session per transport, shared by every call that resolves to it.
  const sessions = new Map<Transport, DirectSession>();
  const opener = (transport: Transport) => async (manifest: Parameters<DirectSession["use"]>[0][number]) => {
    let session = sessions.get(transport);
    if (!session) sessions.set(transport, session = new DirectSession([], () => connectClaude(loaded()), undefined, { transport }));
    session.use([manifest]);
    return session;
  };
  const transportOf = (transport?: Transport) => resolveTransport(loaded(), transport ?? options.transport);

  return {
    async call(request) {
      const pol = loaded();
      const transport = transportOf(request.transport);
      const manifest = requireManifest(pol, request.connector);
      const tool = requireTool(manifest, request.tool);
      if (classify(pol, manifest.id, tool) === "write")
        throw fail("POLICY_DENIED", `${manifest.id}:${tool.name} is a write: call() only reads`, [
          "Plan it with plan(), approve its hash, then send it with write(plan, { key })",
        ]);
      const req = { connector: request.connector, tool: request.tool, args: request.args };
      const { value, raw, via } = await callRead(opener(transport), pol, profileOf(request.profile), req, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, request.signal);
      return { value, raw, via };
    },

    plan(request) {
      const profile = profileOf(request.profile);
      const req = { connector: request.connector, tool: request.tool, args: JSON.parse(JSON.stringify(request.args ?? {})) as Record<string, unknown> };
      return { ...planCall(loaded(), profile, req), request: { ...req, profile } };
    },

    async write(plan, { key, profile, timeoutMs, signal, transport }) {
      const r = plan?.request;
      if (!r || typeof r.connector !== "string" || typeof r.tool !== "string" || typeof plan.hash !== "string")
        throw fail("VALIDATION_ERROR", "Not a plan: write() takes what plan() returned", ["const p = plan(request); await write(p, { key })"]);
      const out = await callWrite(opener(transportOf(transport)), loaded(), { connector: r.connector, tool: r.tool, args: r.args },
        { profile: profileOf(profile), key, expectHash: plan.hash, deadlineMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, signal });
      if (out.replayed) return { replayed: true, key: out.key, ref: out.ref, ...(out.at ? { at: out.at } : {}) };
      return { sent: true, key: out.key, ref: out.ref, value: out.value, raw: out.raw, via: out.via };
    },

    async *batch(lines, o = {}) {
      const pol = loaded();
      const settings = { profile: profileOf(), concurrency: o.concurrency ?? pol.limits.concurrency, perConnector: o.perConnector ?? pol.limits.perConnector,
        ordered: o.ordered === true, budgetMs: o.budgetMs };
      for (const [name, n] of [["concurrency", settings.concurrency], ["perConnector", settings.perConnector]] as const)
        if (!Number.isInteger(n) || n < 1) throw fail("VALIDATION_ERROR", `${name} must be a positive whole number`);
      for await (const r of callBatch((line: BatchCall) => opener(transportOf(line.transport)), pol, lines, settings))
        yield r.ok ? { id: r.id, ok: true, value: r.value, raw: r.raw, via: r.via } : { id: r.id, ok: false, error: r.error };
    },

    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map(session => session.close()));
    },
  };
}

let shared: Plugboard | undefined;
const instance = () => (shared ??= createPlugboard());
/** One read, through the default instance (PLUGBOARD_POLICY, PLUGBOARD_PROFILE, PLUGBOARD_TRANSPORT). */
export const call: Plugboard["call"] = request => instance().call(request);
/** Plans a call through the default instance. */
export const plan: Plugboard["plan"] = request => instance().plan(request);
/** Sends an approved plan through the default instance. */
export const write: Plugboard["write"] = (p, options) => instance().write(p, options);
/** A batch of reads through the default instance. */
export const batch: Plugboard["batch"] = (lines, options) => instance().batch(lines, options);
/** Closes the default instance's sessions now, rather than when idle. */
export const close = () => shared?.close() ?? Promise.resolve();
