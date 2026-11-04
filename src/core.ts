// The safeguards every caller goes through: the CLI and the library alike. A read is decided by the
// policy before a session opens; a write is refused, replayed or audited here, never by the caller.
import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { appendAudit, keyState } from "./audit";
import type { ClaudeConnectors, ConnectorServer } from "./bridge/client";
import type { Manifest } from "./cache";
import type { Prepared } from "./call";
import { costGuard } from "./claude";
import { classify as classifyError, fail } from "./errors";
import { errorText, unwrap } from "./output";
import { decide, profileFor, type Policy } from "./policy";

export const BIN = "plugboard";
/** What the core needs of a Claude Code session; opened only once a call is allowed. */
export type Session = Pick<ClaudeConnectors, "request" | "waitForServers">;
export type OpenSession = () => Promise<Session>;

/** A live server must be connected; anything else is AUTH_REQUIRED (needs-auth, failed) or NOT_FOUND. */
export function requireConnected(servers: ConnectorServer[], manifest: Manifest) {
  const server = servers.find(s => s.name === manifest.connectorName);
  if (!server) throw fail("NOT_FOUND", `${manifest.connectorName} is no longer listed by Claude Code`, [`Run \`${BIN} refresh\``]);
  if (server.status !== "connected") throw fail("AUTH_REQUIRED", `${manifest.connectorName} is ${server.status}`, [
    `Reconnect it in claude.ai → Settings → Connectors${server.error ? ` (${server.error.slice(0, 120)})` : ""}`,
  ]);
}

export async function invoke(client: Pick<ClaudeConnectors, "request">, p: Prepared, deadlineMs: number) {
  let result: Record<string, any>;
  try {
    result = await client.request({ subtype: "mcp_call", tool: p.tool.sourceName, arguments: p.args }, { timeoutMs: deadlineMs });
  } catch (error) {
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

export type ReadResult = { raw: Record<string, any>; value: unknown };

/** One read: the profile must allow it, the connector must be connected, and the session must stay zero-cost. */
export async function callRead(open: OpenSession, policy: Policy, profile: string, p: Prepared, deadlineMs: number): Promise<ReadResult> {
  decide(policy, profile, p.manifest.id, p.tool, false);
  const session = await open();
  requireConnected(await session.waitForServers([p.manifest.connectorName]), p.manifest);
  const raw = await invoke(session, p, deadlineMs);
  await costGuard(session);
  return { raw, value: unwrap(raw) };
}

export type WriteRequest = { profile: string; key: string; expectHash: string; deadlineMs: number };
export type WriteResult =
  | { replayed: true; key: string; ref: string | null; at?: string }
  | { replayed: false; key: string; ref: string | null; raw: Record<string, any>; value: unknown };

/** One write, never retried: the profile must allow it, the payload must be the approved one, and the
 * key names it once. Audited before the call, so a write that can't be audited is never sent. */
export async function callWrite(open: OpenSession, policy: Policy, p: Prepared, req: WriteRequest): Promise<WriteResult> {
  const { profile, key, expectHash } = req;
  if (process.env.CLAUDECODE && !profileFor(policy, profile).allowInAgent)
    throw fail("POLICY_DENIED", "Writes are refused inside a Claude Code session (CLAUDECODE is set)", ["Run the write from your own shell, or set allow_in_agent = true on its profile"]);
  decide(policy, profile, p.manifest.id, p.tool, true);
  if (!key) throw fail("VALIDATION_ERROR", "A write needs a key that names it", ["A key that names this one write, such as reply-42"]);
  if (expectHash !== p.hash) throw fail("POLICY_DENIED", `Payload hash ${p.hash} does not match the approved hash ${expectHash || "(missing)"}`, [
    "The approved payload changed, or was never approved: plan it again and approve the new hash",
  ]);
  const { state, last } = keyState(key);
  if (state === "ok") return { replayed: true, key, ref: (last?.ref as string | undefined) ?? null, at: last?.ts };
  if (state === "unknown") throw fail("WRITE_OUTCOME_UNKNOWN", `A write under key ${key} has no known outcome`, [
    `Check the destination by hand, then run \`${BIN} audit resolve ${key} --sent\` or \`--not-sent\``,
  ]);

  const session = await open();
  requireConnected(await session.waitForServers([p.manifest.connectorName]), p.manifest);
  appendAudit({ key, profile, connector: p.manifest.id, tool: p.tool.name, payload_sha256: p.hash, status: "attempt", pid: process.pid });
  const started = Date.now();
  let raw: Record<string, any>;
  try {
    raw = await invoke(session, p, req.deadlineMs);
  } catch (error) {
    const code = error instanceof AxiError ? error.code : "UPSTREAM_ERROR";
    if (code === "TIMEOUT" || code === "BRIDGE_BROKEN") {
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
