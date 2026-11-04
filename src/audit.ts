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

/** Fold a key's lines in log order, with the one claim rule every reader applies. An attempt is a claim when
 * the key allowed a send just before it (none, or a past error) and no other claim for the key landed in its
 * window: after the `seen` lines its writer had read before trying, and before the attempt itself. Every
 * other attempt lost and sent nothing, whether or not its writer lived to append its `withdrawn` line, so a
 * loser that crashed changes nothing. An attempt without `seen` (an older log) has an empty window; one with a
 * `withdrawn` line lost, whatever its window, since only a losing writer appends one. */
function foldKey(key: string, entries: AuditEntry[]) {
  let state: KeyState = "none";
  let last: AuditEntry | undefined;
  let lastClaim = -1;
  const lost = new Set<AuditEntry>();
  const withdrawn = new Set(entries.filter(e => e.key === key && e.status === "withdrawn").map(e => e.nonce));
  for (const [i, entry] of entries.entries()) {
    if (entry.key !== key || entry.status === "withdrawn") continue;
    if (entry.status === "attempt") {
      const seen = typeof entry.seen === "number" ? entry.seen : i;
      const out = entry.nonce !== undefined && withdrawn.has(entry.nonce); // only a loser withdraws
      if (out || (state !== "none" && state !== "error") || lastClaim >= seen) { lost.add(entry); continue; }
      lastClaim = i;
      state = "unknown";
    } else if (entry.status === "unknown") state = "unknown";
    else if (entry.status === "ok" || entry.status === "resolved-sent") state = "ok";
    else if (entry.status === "error" || entry.status === "resolved-not-sent") state = "error";
    if (entry.status !== "cost-guard") last = entry;
  }
  return { state, last, lost, lastClaim: lastClaim < 0 ? undefined : entries[lastClaim] };
}

/** The outcome of a write key: a claim without outcome = unknown. */
export function keyState(key: string, entries = readAudit()): { state: KeyState; last?: AuditEntry } {
  const { state, last } = foldKey(key, entries);
  return { state, last };
}

/** Attempts that lost a claim, and their `withdrawn` lines: they sent nothing, and the audit listing leaves them out. */
export function lostLines(entries = readAudit()) {
  const lost = new Set<AuditEntry>(entries.filter(e => e.status === "withdrawn"));
  for (const key of new Set(entries.map(e => e.key))) for (const e of foldKey(key, entries).lost) lost.add(e);
  return lost;
}

export function unresolvedKeys(entries = readAudit()) {
  return [...new Set(entries.filter(e => e.status === "attempt").map(e => e.key))].flatMap(key => {
    const { state, lastClaim } = foldKey(key, entries);
    return state === "unknown" && lastClaim ? [lastClaim] : [];
  });
}

/** Claim a key for one write, with the append-only log as the arbiter: append this attempt with a nonce and
 * `seen`, the count of lines the caller read before trying, then re-read and apply the claim rule (`foldKey`).
 * Appends land in one order every process sees, so two writers can't both claim a key, in this process or
 * another. A rival claim that landed meanwhile wins whatever its outcome, so a resend after its error is a new
 * call, never automatic. A losing attempt appends `withdrawn` at once, for readers of the raw log. */
export function claimKey(key: string, attempt: Omit<AuditEntry, "ts" | "nonce" | "seen">, seen = readAudit().length): { claimed: boolean; state: KeyState; last?: AuditEntry } {
  const nonce = randomUUID();
  appendAudit({ ...attempt, nonce, seen });
  const entries = readAudit();
  const mine = entries.findIndex(e => e.status === "attempt" && e.nonce === nonce);
  const upTo = entries.slice(0, mine < 0 ? entries.length : mine + 1);
  const { lost } = foldKey(key, upTo);
  const prior = keyState(key, upTo.slice(0, -1));
  if (mine >= 0 && !lost.has(entries[mine]!)) return { claimed: true, state: prior.state };
  appendAudit({ key, status: "withdrawn", nonce });
  return { claimed: false, ...prior };
}
