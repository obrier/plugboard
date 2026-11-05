// @obrier/plugboard: claude.ai connector tools from code, with the CLI's safeguards (docs/design/library.md).
// The module functions are a default instance, created on first use; createPlugboard() makes another, with its
// own policy, profile, transport and session. Every call goes through the core, as the CLI's do.
import { connectClaude } from "./claude";
import { callRead, callWrite, planCall, type Plan } from "./core";
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
export type WriteOptions = { key: string; timeoutMs?: number; signal?: AbortSignal; transport?: Transport };
/** Sent now, or already sent under this key before (nothing was called). */
export type Written =
  | { sent: true; key: string; ref: string | null; value: unknown; raw: Record<string, unknown>; via: Via }
  | { replayed: true; key: string; ref: string | null; at?: string };
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
      const read = callRead(opener(transport), pol, profileOf(request.profile), req, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, request.signal);
      const { value, raw, via } = await dropWhenCancelled(read, request.signal);
      return { value, raw, via };
    },

    plan(request) {
      const profile = profileOf(request.profile);
      const req = { connector: request.connector, tool: request.tool, args: JSON.parse(JSON.stringify(request.args ?? {})) as Record<string, unknown> };
      return { ...planCall(loaded(), profile, req), request: { ...req, profile } };
    },

    async write(plan, { key, timeoutMs, signal, transport }) {
      const r = plan?.request;
      if (!r || typeof r.connector !== "string" || typeof r.tool !== "string" || typeof plan.hash !== "string")
        throw fail("VALIDATION_ERROR", "Not a plan: write() takes what plan() returned", ["const p = plan(request); await write(p, { key })"]);
      const out = await callWrite(opener(transportOf(transport)), loaded(), { connector: r.connector, tool: r.tool, args: r.args },
        { profile: profileOf(r.profile), key, expectHash: plan.hash, deadlineMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, signal });
      if (out.replayed) return { replayed: true, key: out.key, ref: out.ref, ...(out.at ? { at: out.at } : {}) };
      return { sent: true, key: out.key, ref: out.ref, value: out.value, raw: out.raw, via: out.via };
    },

    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map(session => session.close()));
    },
  };
}

/** A read cancelled is dropped at once, even while its session is still starting. */
function dropWhenCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(fail("TIMEOUT", "Read cancelled"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

let shared: Plugboard | undefined;
const instance = () => (shared ??= createPlugboard());
/** One read, through the default instance (PLUGBOARD_POLICY, PLUGBOARD_PROFILE, PLUGBOARD_TRANSPORT). */
export const call: Plugboard["call"] = request => instance().call(request);
/** Plans a call through the default instance. */
export const plan: Plugboard["plan"] = request => instance().plan(request);
/** Sends an approved plan through the default instance. */
export const write: Plugboard["write"] = (p, options) => instance().write(p, options);
/** Closes the default instance's sessions now, rather than when idle. */
export const close = () => shared?.close() ?? Promise.resolve();
