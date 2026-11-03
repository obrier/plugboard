// Opt-in live smoke test: LIVE=1 bun test test/live.test.ts. Read-only by construction:
// each tool is asserted read-class against the real cache and policy before it is called.
import { expect, test } from "bun:test";
import { loadManifest } from "../src/cache";
import { classify, loadPolicy } from "../src/policy";

const READS: [string, string, string[]][] = [
  ["gmail", "list_labels", []],
  ["google-calendar", "list_calendars", ["--select", "summary", "--items", "calendars"]],
  ["slack", "slack_search_channels", ["--keywords", "general", "--limit", "1", "--response-format", "concise"]],
];

test.skipIf(!process.env.LIVE)("live reads succeed at zero cost, and doctor passes", async () => {
  const policy = loadPolicy();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  for (const [connector, tool, args] of READS) {
    const definition = loadManifest(connector)?.tools.find(t => t.name === tool);
    expect(definition).toBeDefined();
    expect(classify(policy, connector, definition!)).toBe("read");
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/cli.ts`, connector, tool, ...args, "--out", "json"], { env, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0); // exit 0 includes the cost guard: $0.0000, 0 tokens
    expect(() => JSON.parse(out)).not.toThrow();
  }
  const doctor = Bun.spawn(["bun", `${import.meta.dir}/../src/cli.ts`, "doctor", "--as", "gather"], { env, stdout: "pipe" });
  await new Response(doctor.stdout).text();
  expect(await doctor.exited).toBe(0);
}, 120_000);
