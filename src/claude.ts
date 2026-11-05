import { ClaudeConnectors } from "./bridge/client";
import { childEnv } from "./bridge/capture";
import { asPlugboardError, fail, isPermissionError } from "./errors";
import { findClaude } from "./platform";
import type { Manifest } from "./cache";
import { DirectSession, resolveTransport, type Transport } from "./direct";
import type { Policy } from "./policy";
import { runtime } from "./runtime";

export const claudePath = (policy: Policy) => findClaude(policy.claudePath);

function run(path: string, args: string[]) {
  try {
    const proc = runtime.spawnSync([path, ...args], { env: childEnv() });
    return proc.exitCode === 0 ? proc.stdout.trim() : undefined;
  } catch { return undefined; }
}

export const claudeVersion = (path: string) => run(path, ["--version"])?.split(/\s+/)[0];

export function authStatus(path: string): { loggedIn: boolean; method?: string } | undefined {
  const out = run(path, ["auth", "status", "--json"]);
  if (!out) return undefined;
  try { const data = JSON.parse(out); return { loggedIn: data.loggedIn === true, method: data.authMethod }; } catch { return undefined; }
}

/** A session for calling these connectors, by the transport (`resolveTransport`): direct to Anthropic's connector
 * proxy, falling back to Claude Code (auto), direct only, or Claude Code. With no connectors named (refresh, doctor)
 * it's Claude Code's. */
export async function connect(policy: Policy, needs: Manifest[] = [], transport?: Transport): Promise<Pick<ClaudeConnectors, "request" | "waitForServers" | "close">> {
  const t = resolveTransport(policy, transport);
  if (needs.length && t !== "claude-code") return new DirectSession(needs, () => connectClaude(policy), undefined, { fallback: t === "auto" });
  return connectClaude(policy);
}

/** Start Claude Code, mapping spawn and protocol failures to UNREACHABLE. */
export async function connectClaude(policy: Policy) {
  const path = claudePath(policy);
  try {
    return await ClaudeConnectors.connect({ claudePath: path });
  } catch (error) {
    const e = asPlugboardError(error, "UNREACHABLE");
    // Not allowed to start it or make its temp folder: an environment problem, not a broken protocol.
    if (isPermissionError(e.message)) throw fail("UNREACHABLE", `Couldn't start Claude Code (${path}): ${e.message}`, [...e.hints, "Run `plugboard doctor` for details"]);
    const message = e.message;
    throw fail("UNREACHABLE", `Claude Code control protocol failed (${path}): ${message}`, [
      "Run `plugboard doctor` for details",
      "After a breaking update, set claude_path in policy.toml to an earlier Claude Code version (`plugboard doctor` names it)",
    ]);
  }
}

/** One control call: anything other than $0 and zero tokens means a model was reached. */
export async function costGuard(client: Pick<ClaudeConnectors, "request">) {
  let text: string;
  try {
    ({ text } = await client.request<{ text: string }>({ subtype: "get_session_cost" }));
  } catch (error) {
    throw fail("UNREACHABLE", `get_session_cost failed: ${(error as Error).message}`);
  }
  if (!/\$0\.0000\b/.test(text) || !/Usage:\s+0 input, 0 output, 0 cache read, 0 cache write/.test(text))
    throw fail("COST_GUARD", `Session was not zero-cost: ${text.replace(/\s+/g, " ").slice(0, 200)}`, ["Stop using the bridge and investigate: a model was reached"]);
  return text;
}
