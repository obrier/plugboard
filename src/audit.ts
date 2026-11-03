import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths";

export type AuditStatus = "attempt" | "ok" | "error" | "unknown" | "resolved-sent" | "resolved-not-sent" | "cost-guard";
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
  let state: KeyState = "none";
  let last: AuditEntry | undefined;
  for (const entry of entries) {
    if (entry.key !== key) continue;
    if (entry.status === "attempt" || entry.status === "unknown") state = "unknown";
    else if (entry.status === "ok" || entry.status === "resolved-sent") state = "ok";
    else if (entry.status === "error" || entry.status === "resolved-not-sent") state = "error";
    if (entry.status !== "cost-guard") last = entry;
  }
  return { state, last };
}

export function unresolvedKeys(entries = readAudit()) {
  const keys = [...new Set(entries.filter(e => e.status === "attempt").map(e => e.key))];
  return keys.filter(key => keyState(key, entries).state === "unknown")
    .map(key => entries.find(e => e.key === key && e.status === "attempt")!);
}
