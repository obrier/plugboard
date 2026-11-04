import { existsSync, readFileSync } from "node:fs";
import { fail } from "./errors";
import { expandHome, policyPath, transformsPath } from "./platform";
import DEFAULTS from "./defaults.toml";
import { parse as parseTomlText } from "smol-toml";
import type { ManifestTool } from "./cache";

export type Mode = "read" | "write";
export type Profile = { mode: Mode; allow: string[]; deny: string[]; allowDestructive: boolean; allowInAgent: boolean };
export type Policy = {
  source: string | null;
  claudePath?: string;
  aliases: Record<string, string>;
  overrides: { read: string[]; write: string[] };
  transforms: Record<string, string>;
  limits: { concurrency: number; perConnector: number };
  profiles: Record<string, Profile>;
};
export const TIME_FORMATS = ["unix", "unix-ms", "rfc3339", "date"];

export const DEFAULT_ALIASES: Record<string, string> = DEFAULTS.aliases;
const DEFAULT_PROFILE: Profile = { mode: "read", allow: ["*:*"], deny: [], allowDestructive: false, allowInAgent: false };

/** A config error names its file, so policy.toml and transforms.toml are told apart. */
const bad = (path: string, message: string, hints = [`Edit ${path}`]) => fail("VALIDATION_ERROR", `${path}: ${message}`, hints);
const strings = (path: string, key: string, value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== "string")) throw bad(path, `${key} must be a list of strings`);
  return value as string[];
};

const parseToml = (text: string, path: string, hints?: string[]) => {
  try { return parseTomlText(text) as Record<string, any>; } catch (error) {
    // One line with the position, never smol-toml's multi-line code frame.
    const e = error as Error & { line?: number; column?: number };
    const what = e.message.split("\n")[0]!.replace(/^Invalid TOML document: /, "");
    throw bad(path, e.line ? `line ${e.line}, column ${e.column}: ${what}` : what, hints);
  }
};

/** Built-ins, then transforms.toml (its [transforms] only: it can never grant a profile), then policy.toml. */
export function parsePolicy(text: string, path: string, transformsFile?: { text: string; path: string }): Policy {
  const raw = parseToml(text, path);
  if (raw.version !== undefined && raw.version !== 1) throw bad(path, `unsupported version ${raw.version}`);
  const aliases: Record<string, string> = { ...DEFAULT_ALIASES, ...(raw.aliases ?? {}) };
  const resolve = (id: string) => aliases[id] ?? id;
  // Patterns are `connector:tool`; the connector part may be an alias.
  const pattern = (key: string) => (p: string) => {
    const at = p.indexOf(":");
    if (at <= 0 || at === p.length - 1) throw bad(path, `${key}: "${p}" is not connector:tool`);
    return `${resolve(p.slice(0, at))}:${p.slice(at + 1)}`;
  };
  const profiles: Record<string, Profile> = { default: DEFAULT_PROFILE };
  for (const [name, value] of Object.entries<Record<string, unknown>>(raw.profiles ?? {})) {
    const mode = value.mode ?? "read";
    if (mode !== "read" && mode !== "write") throw bad(path, `profiles.${name}.mode must be read or write`);
    profiles[name] = {
      mode,
      allow: strings(path, `profiles.${name}.allow`, value.allow).map(pattern(`profiles.${name}.allow`)),
      deny: strings(path, `profiles.${name}.deny`, value.deny).map(pattern(`profiles.${name}.deny`)),
      allowDestructive: value.allow_destructive === true,
      allowInAgent: value.allow_in_agent === true,
    };
  }
  const transforms: Record<string, string> = {};
  const addTransforms = (source: string, table: unknown, hints?: string[]) => {
    if (table !== undefined && (table === null || typeof table !== "object" || Array.isArray(table)))
      throw bad(source, `transforms must be a table of "connector:tool.param" = "format"`, hints);
    for (const [key, format] of Object.entries(table ?? {})) {
      if (!TIME_FORMATS.includes(String(format))) throw bad(source, `transforms."${key}" must be one of ${TIME_FORMATS.join(", ")}`, hints);
      const at = key.indexOf(":");
      transforms[at > 0 ? `${resolve(key.slice(0, at))}${key.slice(at)}` : key] = String(format);
    }
  };
  addTransforms("built-in defaults", DEFAULTS.transforms);
  if (transformsFile) {
    // Every command reads this file, so a bad line stops them all: say how to get going again.
    const hints = [`Fix or remove the bad line in ${transformsFile.path}; it holds only time transforms`];
    addTransforms(transformsFile.path, parseToml(transformsFile.text, transformsFile.path, hints).transforms, hints);
  }
  addTransforms(path, raw.transforms);
  return {
    source: path,
    claudePath: typeof raw.claude_path === "string" ? expandHome(raw.claude_path) : undefined,
    aliases,
    overrides: {
      read: strings(path, "overrides.read", raw.overrides?.read).map(pattern("overrides.read")),
      write: strings(path, "overrides.write", raw.overrides?.write).map(pattern("overrides.write")),
    },
    transforms,
    limits: { concurrency: raw.limits?.concurrency ?? 4, perConnector: raw.limits?.per_connector ?? 2 },
    profiles,
  };
}

export function loadPolicy(): Policy {
  const path = policyPath();
  const tPath = transformsPath();
  const transformsFile = existsSync(tPath) ? { text: readFileSync(tPath, "utf8"), path: tPath } : undefined;
  if (!existsSync(path)) return { ...parsePolicy("", path, transformsFile), source: null };
  return parsePolicy(readFileSync(path, "utf8"), path, transformsFile);
}

export const resolveConnector = (policy: Policy, ref: string) => policy.aliases[ref] ?? ref;

const globCache = new Map<string, RegExp>();
function glob(pattern: string) {
  let re = globCache.get(pattern);
  if (!re) globCache.set(pattern, re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return re;
}
export const matches = (pattern: string, id: string, tool: string) => glob(pattern).test(`${id}:${tool}`);

export type ToolClass = "read" | "write";
/** Annotations are `readOnly: true` or absent (measured 3 Nov), so anything not marked read is a write. */
export function classify(policy: Policy, id: string, tool: Pick<ManifestTool, "name" | "annotations">): ToolClass {
  const key = `${id}:${tool.name}`;
  if (policy.overrides.write.includes(key)) return "write";
  if (policy.overrides.read.includes(key)) return "read";
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true ? "read" : "write";
}

/** The read tools a profile may call that need no arguments: cheap liveness probes. Some still fail when called bare, so try them in order. */
export function probeTools(policy: Policy, profileName: string, id: string, tools: ManifestTool[]) {
  const allowed = (tool: ManifestTool) => { try { decide(policy, profileName, id, tool, false); return true; } catch { return false; } };
  return tools.filter(tool => classify(policy, id, tool) === "read" && !(tool.inputSchema.required ?? []).length && allowed(tool));
}

export function profileFor(policy: Policy, name: string): Profile {
  const profile = policy.profiles[name];
  if (!profile) throw fail("POLICY_DENIED", `Unknown profile "${name}"`, [`Profiles: ${Object.keys(policy.profiles).join(", ")}`]);
  return profile;
}

/** Throws POLICY_DENIED unless `profileName` may call this tool in this mode.
 * Globs only ever grant read tools: a write tool must be named exactly in a write profile. */
export function decide(policy: Policy, profileName: string, id: string, tool: Pick<ManifestTool, "name" | "annotations">, write: boolean) {
  const profile = profileFor(policy, profileName);
  const key = `${id}:${tool.name}`;
  const cls = classify(policy, id, tool);
  const denied = (message: string, help: string[] = []) => fail("POLICY_DENIED", message, help);
  if (write && profile.mode !== "write") throw denied(`--write needs a write profile; "${profileName}" is read-only`);
  if (profile.deny.some(p => matches(p, id, tool.name))) throw denied(`${key} is denied by profiles.${profileName}.deny`);
  if (cls === "read") {
    if (!profile.allow.some(p => matches(p, id, tool.name))) throw denied(`${key} is not in profiles.${profileName}.allow`);
    return { profile, cls };
  }
  if (profile.mode !== "write") throw denied(`${key} is a write tool and profile "${profileName}" is read-only`, ["Use a profile with mode = \"write\"; see `plugboard policy`"]);
  if (!write) throw denied(`${key} is a write tool: pass --write`);
  if (!profile.allow.includes(key)) throw denied(`write tools must be named exactly in profiles.${profileName}.allow; ${key} is not`);
  if (tool.annotations?.destructiveHint === true && !profile.allowDestructive) throw denied(`${key} is destructive and profiles.${profileName}.allow_destructive is false`);
  return { profile, cls };
}
