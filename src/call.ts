import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { AxiError } from "axi-sdk-js";
import { appendAudit, keyState } from "./audit";
import type { ClaudeConnectors, ConnectorServer } from "./bridge/client";
import { findTool, loadIndex, loadManifest, nearNames, shortName, type Manifest, type ManifestTool } from "./cache";
import { connect, costGuard } from "./claude";
import { classify as classifyError, fail } from "./errors";
import { mergeArgs, parseFlags, summaryOf, toolHelp, typeOf } from "./flags";
import { errorText, OUT_FORMATS, parseList, render, shape, unwrap } from "./output";
import { classify, decide, loadPolicy, profileFor, resolveConnector, type Policy, type ToolClass } from "./policy";
import { formatTime, parseTime } from "./time";

export const BIN = "connectors-axi";

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
export const payloadHash = (connector: string, tool: string, args: unknown) =>
  `sha256:${createHash("sha256").update(canonical({ connector, tool, args }), "utf8").digest("hex")}`;

/** Reads only: `today`, `-2d`… for parameters listed in policy.toml [transforms]. */
export function applyTransforms(policy: Policy, id: string, tool: ManifestTool, args: Record<string, unknown>) {
  const out = { ...args };
  for (const [prop, value] of Object.entries(args)) {
    const format = policy.transforms[`${id}:${tool.name}.${prop}`];
    if (!format || typeof value !== "string") continue;
    const date = parseTime(value);
    if (!date) throw fail("VALIDATION_ERROR", `--${prop}: can't read "${value}" as a time`, ["Try today, -2d, 2026-11-03 or monday 9am"]);
    const formatted = formatTime(date, format);
    out[prop] = typeOf(tool.inputSchema.properties?.[prop]) === "string" ? String(formatted) : formatted;
  }
  return out;
}
export const timeParams = (policy: Policy, id: string, tool: ManifestTool) =>
  Object.keys(tool.inputSchema.properties ?? {}).filter(p => policy.transforms[`${id}:${tool.name}.${p}`]);

export type Prepared = { manifest: Manifest; tool: ManifestTool; args: Record<string, unknown>; cls: ToolClass; hash: string };

/** Everything up to the call: lookup, transforms (reads only), Ajv, class, hash. No spawn. */
export function prepare(policy: Policy, manifest: Manifest, tool: ManifestTool, rawArgs: Record<string, unknown>, write: boolean): Prepared {
  const args = write ? rawArgs : applyTransforms(policy, manifest.id, tool, rawArgs);
  validate(tool, args);
  return { manifest, tool, args, cls: classify(policy, manifest.id, tool), hash: payloadHash(manifest.id, tool.name, args) };
}

// --- the call -------------------------------------------------------------------

export function parseDeadline(value: unknown, fallback = 30_000): number {
  if (value === undefined) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value));
  if (!match) throw fail("VALIDATION_ERROR", `--deadline must look like 30s, 500ms or 2m, got "${value}"`);
  return Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2] as "ms" | "s" | "m"] ?? 1000);
}

/** A live server must be connected; anything else is AUTH_REQUIRED (needs-auth, failed) or NOT_FOUND. */
export function requireConnected(servers: ConnectorServer[], manifest: Manifest) {
  const server = servers.find(s => s.name === manifest.connectorName);
  if (!server) throw fail("NOT_FOUND", `${manifest.connectorName} is no longer listed by Claude Code`, [`Run \`${BIN} refresh\``]);
  if (server.status !== "connected") throw fail("AUTH_REQUIRED", `${manifest.connectorName} is ${server.status}`, [
    `Reconnect it in claude.ai → Settings → Connectors${server.error ? ` (${server.error.slice(0, 120)})` : ""}`,
  ]);
}

export async function invoke(client: Pick<ClaudeConnectors, "request">, p: Prepared, deadlineMs: number) {
  let result: Record<string, any>;
  try {
    result = await client.request({ subtype: "mcp_call", tool: p.tool.sourceName, arguments: p.args }, { timeoutMs: deadlineMs });
  } catch (error) {
    const message = (error as Error).message;
    throw fail(classifyError(message), message);
  }
  if (result.isError === true) {
    const message = errorText(result);
    throw fail(classifyError(message), message);
  }
  return result;
}

/** An id worth keeping as sent_ref: Slack ts, a message or event id, a permalink. */
export function refOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["ts", "message_ts", "messageId", "id", "eventId", "threadId", "permalink"]) {
    const v = (value as any)[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  for (const v of Object.values(value)) if (v && typeof v === "object" && !Array.isArray(v)) { const r = refOf(v); if (r) return r; }
  return undefined;
}

export const profileName = (globals: Record<string, string | boolean>) =>
  String(globals.as ?? process.env.CONNECTORS_AXI_PROFILE ?? "default");

export async function runTool(connectorRef: string, args: string[]) {
  const policy = loadPolicy();
  const manifest = requireManifest(policy, connectorRef);
  const [toolRef, ...rest] = args;
  if (!toolRef || toolRef === "--help") return listTools(policy, manifest);
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
  const format = String(g.out ?? "toon");
  if (!OUT_FORMATS.includes(format)) throw fail("VALIDATION_ERROR", `--out must be one of ${OUT_FORMATS.join(", ")}`);
  const write = g.write === true;
  const profile = profileName(g);
  const p = prepare(policy, manifest, tool, mergeArgs(parsed), write);

  if (g.plan) {
    let decision = "allowed";
    try { decide(policy, profile, manifest.id, tool, cls === "write"); } catch (error) { decision = `denied: ${(error as Error).message}`; }
    const plan = { connector: manifest.id, tool: tool.name, class: cls, destructive: tool.annotations?.destructiveHint === true, profile, decision, hash: p.hash, payload: p.args };
    return format === "json" ? JSON.stringify(plan) : { plan, ...(cls === "write" ? { help: [`Run with --as <write profile> --write --write-key <k> --expect-hash ${p.hash}`] } : {}) };
  }
  decide(policy, profile, manifest.id, tool, write);
  const deadline = parseDeadline(g.deadline);
  const shapeOpts = { select: parseList(g.select as string | undefined), where: g.where as string | undefined, items: g.items as string | undefined };

  if (cls === "write") return runWrite(policy, p, profile, g, deadline, format, shapeOpts);

  const client = await connect(policy);
  try {
    requireConnected(await client.waitForServers([manifest.connectorName]), manifest);
    const raw = await invoke(client, p, deadline);
    await costGuard(client);
    return render({ raw, value: shape(unwrap(raw), shapeOpts), format, full: g.full === true });
  } finally { await client.close(); }
}

async function runWrite(policy: Policy, p: Prepared, profile: string, g: Record<string, string | boolean>, deadline: number,
  format: string, shapeOpts: Parameters<typeof shape>[1]) {
  if (process.env.CLAUDECODE && !profileFor(policy, profile).allowInAgent)
    throw fail("POLICY_DENIED", "Writes are refused inside a Claude Code session (CLAUDECODE is set)", ["Run the write from your own shell, or set allow_in_agent = true on its profile"]);
  const key = g["write-key"];
  if (typeof key !== "string" || !key) throw fail("VALIDATION_ERROR", "--write needs --write-key <k>", ["A key that names this one write, such as reply-42"]);
  if (g["expect-hash"] !== p.hash) throw fail("POLICY_DENIED", `Payload hash ${p.hash} does not match --expect-hash ${g["expect-hash"] ?? "(missing)"}`, [
    "The approved payload changed, or was never approved: run --plan and re-approve",
  ]);
  const { state, last } = keyState(key);
  if (state === "ok") return { replayed: true, key, ref: last?.ref ?? null, at: last?.ts, help: ["Already sent under this key: nothing was called"] };
  if (state === "unknown") throw fail("WRITE_OUTCOME_UNKNOWN", `A write under key ${key} has no known outcome`, [
    "Check the destination by hand, then run `connectors-axi audit resolve " + key + " --sent` or `--not-sent`",
  ]);

  const client = await connect(policy);
  try {
    requireConnected(await client.waitForServers([p.manifest.connectorName]), p.manifest);
    const base = { key, profile, connector: p.manifest.id, tool: p.tool.name, payload_sha256: p.hash };
    appendAudit({ ...base, status: "attempt", pid: process.pid });
    const started = Date.now();
    let raw: Record<string, any>;
    try {
      raw = await invoke(client, p, deadline); // never retried
    } catch (error) {
      const code = error instanceof AxiError ? error.code : "UPSTREAM_ERROR";
      if (code === "TIMEOUT" || code === "BRIDGE_BROKEN") {
        appendAudit({ key, status: "unknown", code, ms: Date.now() - started });
        throw fail("WRITE_OUTCOME_UNKNOWN", `Write ${key} may or may not have happened: ${(error as Error).message}`, [
          "Check the destination by hand, then `connectors-axi audit resolve " + key + " --sent|--not-sent`",
        ]);
      }
      appendAudit({ key, status: "error", code, message: (error as Error).message.slice(0, 300), ms: Date.now() - started });
      throw error;
    }
    const value = unwrap(raw);
    const ref = refOf(value);
    appendAudit({ key, status: "ok", ms: Date.now() - started, result_sha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"), ...(ref ? { ref } : {}) });
    try { await costGuard(client); } catch (error) { appendAudit({ key, status: "cost-guard", message: (error as Error).message }); throw error; }
    return render({ raw, value: shape(value, shapeOpts), format, full: g.full === true, header: { sent: true, key, ref: ref ?? null } });
  } finally { await client.close(); }
}

export function listTools(policy: Policy, manifest: Manifest) {
  const tools = manifest.tools.map(t => {
    const cls = classify(policy, manifest.id, t);
    return { name: shortName(manifest.id, t.name), class: cls + (t.annotations?.destructiveHint ? "!" : ""), summary: summaryOf(t.description, 90) };
  }).sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
  return {
    connector: manifest.id, name: manifest.connectorName, captured: manifest.capturedAt, tools,
    help: [`Run \`${BIN} ${manifest.id} <tool> --help\` for its flags`, "class: read | write (write! = destructive). Writes need the executor profile"],
  };
}
