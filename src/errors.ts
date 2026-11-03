import { AxiError } from "axi-sdk-js";

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

export const retryable = (code: Code) => code === "RATE_LIMITED" || code === "TIMEOUT";

/** "retry after 12" / "Retry-After: 12" in an upstream message, in ms. */
export function retryAfterMs(message: string): number | undefined {
  const match = /retry[- ]after:?\s*(\d+)/i.exec(message);
  return match ? Number(match[1]) * 1000 : undefined;
}
