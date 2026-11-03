import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeConnectors } from "./bridge/client";
import { childEnv } from "./bridge/capture";
import { fail } from "./errors";
import type { Policy } from "./policy";

export const claudePath = (policy: Policy) => process.env.CONNECTORS_AXI_CLAUDE ?? policy.claudePath ?? join(homedir(), ".local/bin/claude");

function run(path: string, args: string[]) {
  try {
    const proc = Bun.spawnSync([path, ...args], { env: childEnv(), stdout: "pipe", stderr: "ignore" });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : undefined;
  } catch { return undefined; }
}

export const claudeVersion = (path: string) => run(path, ["--version"])?.split(/\s+/)[0];

export function authStatus(path: string): { loggedIn: boolean; method?: string } | undefined {
  const out = run(path, ["auth", "status", "--json"]);
  if (!out) return undefined;
  try { const data = JSON.parse(out); return { loggedIn: data.loggedIn === true, method: data.authMethod }; } catch { return undefined; }
}

/** Connect, mapping spawn and protocol failures to BRIDGE_BROKEN. */
export async function connect(policy: Policy) {
  const path = claudePath(policy);
  try {
    return await ClaudeConnectors.connect({ claudePath: path });
  } catch (error) {
    throw fail("BRIDGE_BROKEN", `Claude Code control protocol failed (${path}): ${(error as Error).message}`, [
      "Run `connectors-axi doctor` for details",
      "After a breaking update, set claude_path in policy.toml to a version under ~/.local/share/claude/versions/",
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
