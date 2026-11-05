import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { findTool, loadIndex, loadManifest, nearNames, shortName, type Manifest, type ManifestTool } from "./cache";
import { connect } from "./claude";
import { fail } from "./errors";
import { kebab, mergeArgs, parseFlags, summaryOf, toolHelp, typeOf } from "./flags";
import { defaultFormat, OUT_FORMATS, parseList, render, shape } from "./output";
import { loadUsage } from "./usage";
import { classify, decide, loadPolicy, resolveConnector, type Policy, type ToolClass } from "./policy";
import { formatTime, inFormat, parseTime } from "./time";

import { BIN, callRead, callWrite, planCall, type OpenSession } from "./core";
export { BIN };

// --- lookup ---------------------------------------------------------------------

export function requireManifest(policy: Policy, ref: string): Manifest {
  const id = resolveConnector(policy, ref);
  const manifest = loadManifest(id);
  if (manifest) return manifest;
  const entry = loadIndex()?.connectors[id];
  if (entry) throw fail("AUTH_REQUIRED", `${id} has no cached tools (status: ${entry.status})`, [
    `Reconnect ${entry.name.replace(/^claude\.ai /, "")} in claude.ai → Settings → Connectors, then run \`${BIN} refresh ${id}\``,
  ]);
  const known = Object.keys(loadIndex()?.connectors ?? {});
  throw fail("NOT_FOUND", `Unknown connector "${ref}"`, [known.length ? `Connectors: ${known.join(", ")}` : `Run \`${BIN} refresh\` first`]);
}

export function requireTool(manifest: Manifest, ref: string): ManifestTool {
  const tool = findTool(manifest, ref);
  if (tool) return tool;
  const near = nearNames(manifest, ref);
  throw fail("NOT_FOUND", `${manifest.id} has no tool "${ref}"`, [
    ...(near.length ? [`Did you mean: ${near.join(", ")}`] : []),
    `Run \`${BIN} ${manifest.id}\` to list its tools, or \`${BIN} refresh ${manifest.id}\` if it is new`,
  ]);
}

// --- validation and hashing ------------------------------------------------------

const ajvOptions = { strict: false, allErrors: true, addUsedSchema: false };
const draft7 = addFormats(new Ajv(ajvOptions));
const draft2020 = addFormats(new Ajv2020(ajvOptions));
const compiled = new Map<string, ValidateFunction>();
export function validate(tool: ManifestTool, args: Record<string, unknown>) {
  let check = compiled.get(tool.sourceName);
  if (!check) {
    const validator = tool.inputSchema.$schema === "https://json-schema.org/draft/2020-12/schema" ? draft2020 : draft7;
    compiled.set(tool.sourceName, check = validator.compile(tool.inputSchema));
  }
  if (!check(args)) throw fail("VALIDATION_ERROR", `Invalid arguments for ${tool.name}: ${(check.errors ?? []).map(e => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`, [
    `Run \`${BIN} <connector> ${tool.name} --help\` for its flags`,
  ]);
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** The approval's hash: the connector, the tool (its name and, when given, the id the bridge calls) and the args. */
export const payloadHash = (connector: string, tool: string, args: unknown, call?: string) =>
  `sha256:${createHash("sha256").update(canonical({ connector, tool, args, ...(call ? { call } : {}) }), "utf8").digest("hex")}`;

const SCHEMA_FORMATS: Record<string, string> = { "date-time": "rfc3339", date: "date" };
/** A read tool's parameter time format: a [transforms] rule, keyed by the raw names or the ones the CLI shows,
 * else the format its schema declares. Write tools never convert: their payload is sent as approved. */
const transformFor = (policy: Policy, id: string, tool: ManifestTool, prop: string) =>
  classify(policy, id, tool) !== "read" ? undefined
  : policy.transforms[`${id}:${tool.name}.${prop}`] ?? policy.transforms[`${id}:${shortName(id, tool.name)}.${kebab(prop)}`]
    ?? SCHEMA_FORMATS[tool.inputSchema.properties?.[prop]?.format];

/** Reads only: `today`, `-2d`… for parameters with a transform. */
export function applyTransforms(policy: Policy, id: string, tool: ManifestTool, args: Record<string, unknown>) {
  const out = { ...args };
  for (const [prop, value] of Object.entries(args)) {
    const format = transformFor(policy, id, tool, prop);
    if (!format || typeof value !== "string" || inFormat(value, format)) continue;
    const date = parseTime(value);
    if (!date) throw fail("VALIDATION_ERROR", `--${prop}: can't read "${value}" as a time`, ["Try today, -2d, 2026-11-03 or monday 9am"]);
    const formatted = formatTime(date, format);
    out[prop] = typeOf(tool.inputSchema.properties?.[prop]) === "string" ? String(formatted) : formatted;
  }
  return out;
}
export const timeParams = (policy: Policy, id: string, tool: ManifestTool) =>
  Object.keys(tool.inputSchema.properties ?? {}).filter(p => transformFor(policy, id, tool, p));

export type Prepared = { manifest: Manifest; tool: ManifestTool; args: Record<string, unknown>; cls: ToolClass; hash: string };

/** Everything up to the call: lookup, transforms (reads only), Ajv, class, hash. No spawn. */
export function prepare(policy: Policy, manifest: Manifest, tool: ManifestTool, rawArgs: Record<string, unknown>, write: boolean): Prepared {
  const args = write ? rawArgs : applyTransforms(policy, manifest.id, tool, rawArgs);
  validate(tool, args);
  return { manifest, tool, args, cls: classify(policy, manifest.id, tool), hash: payloadHash(manifest.id, tool.name, args, tool.sourceName) };
}

// --- the call -------------------------------------------------------------------

export function parseDeadline(value: unknown, fallback = 30_000): number {
  if (value === undefined) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value));
  if (!match) throw fail("VALIDATION_ERROR", `--deadline must look like 30s, 500ms or 2m, got "${value}"`);
  return Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2] as "ms" | "s" | "m"] ?? 1000);
}

export const profileName = (globals: Record<string, string | boolean>) =>
  String(globals.as ?? process.env.PLUGBOARD_PROFILE ?? "default");

export async function runTool(connectorRef: string, args: string[]) {
  const policy = loadPolicy();
  const manifest = requireManifest(policy, connectorRef);
  const [toolRef, ...rest] = args;
  if (!toolRef || toolRef.startsWith("--")) {
    const unknown = args.filter(a => a !== "--all" && a !== "--help");
    if (unknown.length) throw fail("VALIDATION_ERROR", `unknown flag ${unknown[0]} for \`${BIN} ${manifest.id}\``, [`usage: ${BIN} ${manifest.id} [--all]`]);
    return listTools(policy, manifest, { all: args.includes("--all") });
  }
  const tool = requireTool(manifest, toolRef);
  const parsed = parseFlags(rest, tool.inputSchema);
  const g = parsed.globals;
  const cls = classify(policy, manifest.id, tool);
  if (g.help) {
    const reason = policy.overrides.read.includes(`${manifest.id}:${tool.name}`) || policy.overrides.write.includes(`${manifest.id}:${tool.name}`)
      ? "policy override" : tool.annotations?.readOnlyHint ? "readOnlyHint" : "no readOnlyHint: fail closed";
    return toolHelp({ bin: BIN, connector: manifest.id, short: shortName(manifest.id, tool.name), schema: tool.inputSchema, description: tool.description,
      cls: `${cls}${tool.annotations?.destructiveHint ? ", destructive" : ""}`, reason, timeParams: timeParams(policy, manifest.id, tool), full: g.full === true });
  }
  const format = String(g.out ?? defaultFormat());
  if (!OUT_FORMATS.includes(format)) throw fail("VALIDATION_ERROR", `--out must be one of ${OUT_FORMATS.join(", ")}`);
  const write = g.write === true;
  const profile = profileName(g);
  // The raw request: the core resolves, validates and hashes it, and fills a tool's own idempotency_key from the key.
  const request = { connector: manifest.id, tool: tool.name, args: mergeArgs(parsed) };
  const key = typeof g["write-key"] === "string" ? g["write-key"] : undefined;

  const plan = planCall(policy, profile, request, key); // validates the args: a bad arg is exit 2 before any policy refusal
  if (g.plan) {
    return format === "json" ? JSON.stringify(plan) : { plan, ...(cls === "write" ? { help: [`Run with --as <write profile> --write --write-key <k> --expect-hash ${plan.hash}`] } : {}) };
  }
  decide(policy, profile, manifest.id, tool, write); // the flags make sense for this tool; the core decides again
  const deadline = parseDeadline(g.deadline);
  const shapeOpts = { select: parseList(g.select as string | undefined), where: g.where as string | undefined, items: g.items as string | undefined };

  // The CLI's session: opened by the core once the call is allowed, closed here whatever happens.
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  const open: OpenSession = async () => (client = await connect(policy, [manifest]));
  try {
    if (cls === "write") {
      const out = await callWrite(open, policy, request, { profile, key: key ?? "", expectHash: String(g["expect-hash"] ?? ""), deadlineMs: deadline });
      if (out.replayed) return { ...out, help: ["Already sent under this key: nothing was called"] };
      return render({ raw: out.raw, value: shape(out.value, shapeOpts), format, full: g.full === true, header: { sent: true, key: out.key, ref: out.ref } });
    }
    const out = await callRead(open, policy, profile, request, deadline);
    return render({ raw: out.raw, value: shape(out.value, shapeOpts), format, full: g.full === true });
  } finally { await client?.close(); }
}

/** With usage data (`plugboard usage`), used tools come first and the list is capped; --all shows everything. */
export function listTools(policy: Policy, manifest: Manifest, o: { all?: boolean; cap?: number } = {}) {
  const cap = o.cap ?? 20;
  const counts = loadUsage()?.counts ?? {};
  const used = (name: string) => counts[`${manifest.id}:${name}`] ?? 0;
  const ranked = Object.keys(counts).some(k => k.startsWith(`${manifest.id}:`));
  const all = manifest.tools.map(t => ({
    name: shortName(manifest.id, t.name),
    class: classify(policy, manifest.id, t) + (t.annotations?.destructiveHint ? "!" : ""),
    ...(ranked ? { uses: used(t.name) } : {}),
    summary: summaryOf(t.description, 90),
  })).sort((a, b) => ((b.uses ?? 0) - (a.uses ?? 0)) || a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
  const tools = ranked && !o.all ? all.slice(0, cap) : all;
  const hidden = all.length - tools.length;
  return {
    connector: manifest.id, name: manifest.connectorName, captured: manifest.capturedAt, tools,
    help: [
      ...(hidden ? [`${hidden} more tools: add --all, or \`${BIN} find <words>\``] : []),
      ...(ranked ? [] : [`Run \`${BIN} usage\` to rank tools by how often your Claude Code sessions call them`]),
      `Run \`${BIN} ${manifest.id} <tool> --help\` for its flags`,
      "class: read | write (write! = destructive). Writes need a profile with mode = \"write\"",
    ],
  };
}
