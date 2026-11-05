// The safeguards every caller goes through: the CLI and the library alike. A read is decided by the
// policy before a session opens; a write is refused, replayed or audited here, never by the caller.
import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { appendAudit, claimKey, keyState, readAudit, type AuditEntry } from "./audit";
import type { ClaudeConnectors, ConnectorServer } from "./bridge/client";
import type { Manifest } from "./cache";
import { prepare, requireManifest, requireTool, type Prepared } from "./call";
import { costGuard } from "./claude";
import { asAxiError, classify as classifyError, fail, wasNotSent, type Code } from "./errors";
import { errorText, unwrap } from "./output";
import { classify, decide, profileFor, type Policy } from "./policy";

import { BIN, requireConnected } from "./connected";
export { BIN, requireConnected };
/** What the core needs of a Claude Code session; opened only once a call is allowed. */
export type Session = Pick<ClaudeConnectors, "request" | "waitForServers">;
export type OpenSession = () => Promise<Session>;

export async function invoke(client: Pick<ClaudeConnectors, "request">, p: Prepared, deadlineMs: number) {
  let result: Record<string, any>;
  try {
    result = await client.request({ subtype: "mcp_call", tool: p.tool.sourceName, arguments: p.args }, { timeoutMs: deadlineMs });
  } catch (error) {
    if (error instanceof AxiError) throw error; // a session that already knows what failed (the direct path) keeps its code
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

function mint(policy: Policy, req: CallRequest, key?: string): Prepared {
  const manifest = requireManifest(policy, req.connector);
  const tool = requireTool(manifest, req.tool);
  // Plain JSON once, before transforms, validation and the hash: the wire is JSON, so what is checked and
  // approved is exactly what is sent (no toJSON, getter or Date can change between the two).
  const args = JSON.parse(JSON.stringify(req.args ?? {})) as Record<string, unknown>;
  // A tool with its own idempotency_key gets the write key, so the service refuses a duplicate too; part of the hash.
  if (key && "idempotency_key" in (tool.inputSchema.properties ?? {}) && args.idempotency_key === undefined) args.idempotency_key = key;
  return prepare(policy, manifest, tool, args, classify(policy, manifest.id, tool) === "write");
}

export type Plan = { connector: string; tool: string; class: string; destructive: boolean; profile: string; decision: string; hash: string; payload: Record<string, unknown> };
/** What a call would send and whether the profile allows it; a write's hash is what its approval names. */
export function planCall(policy: Policy, profile: string, req: CallRequest, key?: string): Plan {
  const p = mint(policy, req, key);
  let decision = "allowed";
  try { decide(policy, profile, p.manifest.id, p.tool, p.cls === "write"); } catch (error) { decision = `denied: ${(error as Error).message}`; }
  return { connector: p.manifest.id, tool: p.tool.name, class: p.cls, destructive: p.tool.annotations?.destructiveHint === true, profile, decision, hash: p.hash, payload: p.args };
}

export type ReadResult = { raw: Record<string, any>; value: unknown };

/** One read: the profile must allow it, the connector must be connected, and the session must stay zero-cost. */
export async function callRead(open: OpenSession, policy: Policy, profile: string, req: CallRequest, deadlineMs: number): Promise<ReadResult> {
  const p = mint(policy, req);
  decide(policy, profile, p.manifest.id, p.tool, false);
  const session = await open();
  requireConnected(await session.waitForServers([p.manifest.connectorName]), p.manifest);
  const raw = await invoke(session, p, deadlineMs);
  await costGuard(session);
  return { raw, value: unwrap(raw) };
}

/** An attempt with no outcome yet, still within its deadline (and a minute's grace): another write is running it.
 * An older one crashed or lost its answer: its outcome is unknown. */
function inFlight(last: AuditEntry | undefined) {
  if (last?.status !== "attempt") return false;
  const deadline = typeof last.deadline_ms === "number" ? last.deadline_ms : 30_000;
  return Date.now() - Date.parse(last.ts) < deadline + 60_000;
}

export type WriteRequest = { profile: string; key: string; expectHash: string; deadlineMs: number };
export type WriteResult =
  | { replayed: true; key: string; ref: string | null; at?: string }
  | { replayed: false; key: string; ref: string | null; raw: Record<string, any>; value: unknown };

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

  const session = await open();
  requireConnected(await session.waitForServers([p.manifest.connectorName]), p.manifest);
  // Re-checked and claimed in one step right before the call: a concurrent write under this key can't also send.
  let claim: ReturnType<typeof claimKey>;
  try {
    claim = claimKey(key, { key, profile, connector: p.manifest.id, tool: p.tool.name, payload_sha256: p.hash, status: "attempt", pid: process.pid, deadline_ms: req.deadlineMs }, seen.length);
  } catch (error) { // the audit log can't record the attempt: nothing is sent
    const e = asAxiError(error);
    throw fail(e.code as Code, `Write ${key} was not sent: ${e.message}`, e.suggestions);
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
    raw = await invoke(session, p, req.deadlineMs);
  } catch (error) {
    const code = error instanceof AxiError ? error.code : "UPSTREAM_ERROR";
    if ((code === "TIMEOUT" || code === "BRIDGE_BROKEN") && !wasNotSent(error)) {
      appendAudit({ key, status: "unknown", code, ms: Date.now() - started });
      throw fail("WRITE_OUTCOME_UNKNOWN", `Write ${key} may or may not have happened: ${(error as Error).message}`, [
        `Check the destination by hand, then \`${BIN} audit resolve ${key} --sent|--not-sent\``,
      ]);
    }
    appendAudit({ key, status: "error", code, message: (error as Error).message.slice(0, 300), ms: Date.now() - started });
    throw error;
  }
  const value = unwrap(raw);
  const ref = refOf(value) ?? null;
  appendAudit({ key, status: "ok", ms: Date.now() - started, result_sha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"), ...(ref ? { ref } : {}) });
  try { await costGuard(session); } catch (error) { appendAudit({ key, status: "cost-guard", message: (error as Error).message }); throw error; }
  return { replayed: false, key, ref, raw, value };
}
