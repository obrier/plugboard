import { AxiError } from "axi-sdk-js";
import { DiscoveryTimeoutError } from "./bridge/client";
import { collapseHome, stateDir } from "./platform";

export const EXIT = {
  OK: 0, UPSTREAM_ERROR: 1, TIMEOUT: 1, UNKNOWN: 1, VALIDATION_ERROR: 2, NOT_FOUND: 2,
  POLICY_DENIED: 3, AUTH_REQUIRED: 4, RATE_LIMITED: 5, WRITE_OUTCOME_UNKNOWN: 6, PARTIAL: 7,
  BRIDGE_BROKEN: 10, COST_GUARD: 10,
} as const;
export type Code = keyof typeof EXIT;

export const fail = (code: Code, message: string, help: string[] = []) => new AxiError(message, code, help);
export const exitFor = (error: unknown) => (error instanceof AxiError ? EXIT[error.code as Code] ?? 1 : 1);

// Matched against thrown control errors and isError text. Order matters: first hit wins.
const TABLE: [Code, RegExp][] = [
  ["AUTH_REQUIRED", /\b(401|403)\b|invalid_auth|not_authed|token expired|needs? authentication|unauthori[sz]ed|MCP server not connected/i],
  ["RATE_LIMITED", /\b429\b|rate.?limit|too many requests|quota exceeded/i],
  ["TIMEOUT", /timed out waiting for mcp_call/i],
  ["BRIDGE_BROKEN", /closed stdout|client is closed|Invalid control response|Invalid mcp_status/i],
];

export function classify(message: string): Code {
  return TABLE.find(([, pattern]) => pattern.test(message))?.[0] ?? "UPSTREAM_ERROR";
}

// An agent's sandbox (Codex's, for one) blocks writes outside its workspace and the network by default.
const PERMISSION = /\b(EPERM|EACCES)\b|operation not permitted|permission denied/i;
/** What an agent's sandbox must allow, with a link that works without the repo. */
export const SANDBOX_HINT_URL = "https://github.com/obrier/plugboard/blob/main/docs/harness-guides.md#sandboxes";
export const sandboxHint = () => `If an agent's sandbox runs this (Codex, for one), allow network access and writes to the temp folder and ${collapseHome(stateDir())}: ${SANDBOX_HINT_URL}`;
export const isPermissionError = (message: string) => PERMISSION.test(message);

/** Every error as plugboard reports it, with a code and hints. The one place unknown errors get explained:
 * the CLI, batch and doctor all go through it. */
export function asAxiError(error: unknown, fallback: Code = "UNKNOWN"): AxiError {
  if (error instanceof AxiError) return error;
  if (error instanceof DiscoveryTimeoutError) {
    const pending = error.servers.filter(s => s.status === "pending").map(s => s.name);
    return error.servers.length
      ? fail("BRIDGE_BROKEN", `Timed out waiting for connector discovery; still pending: ${pending.join(", ") || "none"}`, ["Run `plugboard doctor` for details"])
      : fail("BRIDGE_BROKEN", "Claude Code listed no connectors in time: it can't reach claude.ai, or isn't logged in", [sandboxHint(), "Run `plugboard doctor` for details"]);
  }
  const message = error instanceof Error ? error.message : String(error);
  const known = classify(message); // the table above, before the caller's fallback
  return fail(known === "UPSTREAM_ERROR" ? fallback : known, message, isPermissionError(message) ? [sandboxHint()] : []);
}

export const retryable = (code: Code) => code === "RATE_LIMITED" || code === "TIMEOUT";

/** "retry after 12" / "Retry-After: 12" in an upstream message, in ms. */
export function retryAfterMs(message: string): number | undefined {
  const match = /retry[- ]after:?\s*(\d+)/i.exec(message);
  return match ? Number(match[1]) * 1000 : undefined;
}
