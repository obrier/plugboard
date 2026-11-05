// Everything up to a call, for the core and the CLI alike: the connector and tool looked up in the cache, a read's
// time transforms, the args validated against the tool's schema, and the approval's hash. No spawn, no network.
import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { findTool, loadIndex, loadManifest, nearNames, shortName, type Manifest, type ManifestTool } from "./cache";
import { BIN } from "./connected";
import { fail } from "./errors";
import { kebab, typeOf } from "./flags";
import { classify, resolveConnector, type Policy, type ToolClass } from "./policy";
import { formatTime, inFormat, parseTime } from "./time";

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
