import { ClaudeConnectors } from "./bridge/client";
import { childEnv } from "./bridge/capture";
import { asAxiError, fail, isPermissionError } from "./errors";
import { findClaude } from "./platform";
import type { Manifest } from "./cache";
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

/** With PLUGBOARD_ONE_CONNECTOR=1, a session for these connectors starts Claude Code with only them, from the
 * config `refresh` cached (~220 ms less discovery). Any of them not connected (an ID claude.ai no longer knows
 * fails within a second) closes that session for a normal start, which reports the connector's real state. */
async function connectOnly(path: string, needs: Manifest[]) {
  const wanted = [...new Map(needs.map(m => [m.connectorName, m])).values()];
  if (process.env.PLUGBOARD_ONE_CONNECTOR !== "1" || !wanted.length || !wanted.every(m => m.server)) return undefined;
  let client: ClaudeConnectors | undefined;
  try {
    client = await ClaudeConnectors.connect({ claudePath: path, discoveryTimeoutMs: 10_000,
      mcpServers: Object.fromEntries(wanted.map(m => [m.connectorName, m.server!])) });
    const servers = await client.waitForServers(wanted.map(m => m.connectorName));
    if (wanted.every(m => servers.some(s => s.name === m.connectorName && s.status === "connected"))) return client;
  } catch { /* the normal start below reports it */ }
  await client?.close();
  return undefined;
}

/** Connect, mapping spawn and protocol failures to BRIDGE_BROKEN. `needs`: the connectors the session will call. */
export async function connect(policy: Policy, needs: Manifest[] = []) {
  const path = claudePath(policy);
  try {
    return (await connectOnly(path, needs)) ?? await ClaudeConnectors.connect({ claudePath: path });
  } catch (error) {
    const e = asAxiError(error, "BRIDGE_BROKEN");
    // Not allowed to start it or make its temp folder: an environment problem, not a broken protocol.
    if (isPermissionError(e.message)) throw fail("BRIDGE_BROKEN", `Couldn't start Claude Code (${path}): ${e.message}`, [...e.suggestions, "Run `plugboard doctor` for details"]);
    const message = e.message;
    throw fail("BRIDGE_BROKEN", `Claude Code control protocol failed (${path}): ${message}`, [
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
    throw fail("BRIDGE_BROKEN", `get_session_cost failed: ${(error as Error).message}`);
  }
  if (!/\$0\.0000\b/.test(text) || !/Usage:\s+0 input, 0 output, 0 cache read, 0 cache write/.test(text))
    throw fail("COST_GUARD", `Session was not zero-cost: ${text.replace(/\s+/g, " ").slice(0, 200)}`, ["Stop using the bridge and investigate: a model was reached"]);
  return text;
}
