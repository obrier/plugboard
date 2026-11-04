import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./platform";

export type AuditStatus = "attempt" | "ok" | "error" | "unknown" | "resolved-sent" | "resolved-not-sent" | "cost-guard" | "withdrawn";
export type AuditEntry = { ts: string; key: string; status: AuditStatus; [field: string]: unknown };

export const auditPath = () => join(stateDir(), "audit.jsonl");

/** Append and fsync: an `attempt` line is on disk before the write is sent, so a crash reads as unknown. */
export function appendAudit(entry: Omit<AuditEntry, "ts">) {
  mkdirSync(stateDir(), { recursive: true });
  const fd = openSync(auditPath(), "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function readAudit(): AuditEntry[] {
  if (!existsSync(auditPath())) return [];
  return readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as AuditEntry]; } catch { return []; }
  });
}

export type KeyState = "none" | "ok" | "error" | "unknown";
/** The outcome of a write key, folded over its lines: attempt without outcome = unknown. */
export function keyState(key: string, entries = readAudit()): { state: KeyState; last?: AuditEntry } {
  const withdrawn = new Set(entries.filter(e => e.key === key && e.status === "withdrawn").map(e => e.nonce));
  let state: KeyState = "none";
  let last: AuditEntry | undefined;
  for (const entry of entries) {
    if (entry.key !== key || entry.status === "withdrawn" || (entry.status === "attempt" && entry.nonce !== undefined && withdrawn.has(entry.nonce))) continue;
    // After a send no later attempt can win a claim: one left open (its writer crashed before withdrawing) changes nothing.
    if (state === "ok" && entry.status === "attempt") continue;
    if (entry.status === "attempt" || entry.status === "unknown") state = "unknown";
    else if (entry.status === "ok" || entry.status === "resolved-sent") state = "ok";
    else if (entry.status === "error" || entry.status === "resolved-not-sent") state = "error";
    if (entry.status !== "cost-guard") last = entry;
  }
  return { state, last };
}

export function unresolvedKeys(entries = readAudit()) {
  const keys = [...new Set(entries.filter(e => e.status === "attempt").map(e => e.key))];
  const withdrawn = new Set(entries.filter(e => e.status === "withdrawn").map(e => e.nonce));
  const open = (key: string) => entries.findLast(e => e.key === key && e.status === "attempt" && !(e.nonce !== undefined && withdrawn.has(e.nonce)))!;
  return keys.filter(key => keyState(key, entries).state === "unknown").map(open);
}


/** Claim a key for one write, with the append-only log as the arbiter: append this attempt with a nonce, then
 * re-read. The claim holds only if the key's state just before this attempt allows a send (none, or a past
 * error) and no other attempt for the key landed since the caller first read the log (`seen` entries): a rival
 * that started meanwhile wins, whatever its outcome, so a resend after its error is a new call, never automatic.
 * A losing attempt is withdrawn at once. Appends land in one order every process sees, so two writers can't
 * both claim a key, in this process or another. */
export function claimKey(key: string, attempt: Omit<AuditEntry, "ts" | "nonce">, seen = readAudit().length): { claimed: boolean; rival: boolean; state: KeyState; last?: AuditEntry } {
  const nonce = randomUUID();
  appendAudit({ ...attempt, nonce });
  const entries = readAudit();
  const mine = entries.findIndex(e => e.status === "attempt" && e.nonce === nonce);
  const before = entries.slice(0, mine < 0 ? entries.length : mine);
  const prior = keyState(key, before);
  const rival = before.slice(seen).some(e => e.key === key && e.status === "attempt");
  if (mine >= 0 && !rival && (prior.state === "none" || prior.state === "error")) return { claimed: true, rival, state: prior.state };
  appendAudit({ key, status: "withdrawn", nonce });
  return { claimed: false, rival, ...prior };
}
