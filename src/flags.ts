import { readFileSync } from "node:fs";
import { fail } from "./errors";
import { expandHome } from "./paths";

type Schema = Record<string, any>;

/** The CLI's own flags. Checked 3 Nov against all 1,396 tool parameter names: none collide.
 * A tool parameter that ever does is reachable only through --json. */
export const GLOBAL_FLAGS = ["as", "write", "plan", "expect-hash", "write-key", "json", "arg-file", "select", "where", "out", "items", "deadline", "full", "help", "axi"] as const;
const RESERVED = new Set<string>(GLOBAL_FLAGS);
const BOOLEAN_GLOBALS = new Set(["write", "plan", "full", "help", "axi"]);

export const kebab = (name: string) => name.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const usage = (message: string, help: string[] = []) => fail("VALIDATION_ERROR", message, help);

/** JSON Schema type of a property, folding enums and nullable unions. */
export function typeOf(schema: Schema | undefined): string {
  if (!schema) return "any";
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t: string) => t !== "null");
    return types.length === 1 ? types[0] : "any";
  }
  if (Array.isArray(schema.enum)) {
    const kinds = new Set(schema.enum.map((v: unknown) => typeof v));
    return kinds.size === 1 ? (kinds.has("number") ? "number" : kinds.has("boolean") ? "boolean" : "string") : "any";
  }
  return "any";
}
const scalar = (type: string) => ["string", "integer", "number", "boolean"].includes(type);

function readJsonFile(path: string, flag: string) {
  try { return JSON.parse(path === "-" ? readFileSync(0, "utf8") : readFileSync(expandHome(path), "utf8")); }
  catch (error) { throw usage(`${flag}: can't read JSON from ${path}: ${(error as Error).message}`); }
}

function parseBool(raw: string, flag: string) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw usage(`${flag} takes true or false, got "${raw}"`);
}

/** Turn one flag value into what the schema expects. Ajv still validates the merged object afterwards. */
export function coerce(schema: Schema | undefined, raw: string, flag: string): unknown {
  const type = typeOf(schema);
  if (type === "string") {
    if (Array.isArray(schema?.enum) && !schema!.enum.includes(raw)) throw usage(`${flag} must be one of ${schema!.enum.join(", ")}, got "${raw}"`);
    return raw;
  }
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n)))
      throw usage(`${flag} must be ${type === "integer" ? "a whole number" : "a number"}, got "${raw}"`);
    if (Array.isArray(schema?.enum) && !schema!.enum.includes(n)) throw usage(`${flag} must be one of ${schema!.enum.join(", ")}`);
    return n;
  }
  if (type === "boolean") return parseBool(raw, flag);
  // Objects, arrays of objects, anyOf/oneOf/$ref and untyped: JSON, @file, or (when allowed) the plain string.
  if (raw.startsWith("@")) return readJsonFile(raw.slice(1), flag);
  try { return JSON.parse(raw); } catch {
    if (type === "object" || type === "array") throw usage(`${flag} needs JSON or @file.json`);
    return raw;
  }
}

export type Parsed = { globals: Record<string, string | boolean>; args: Record<string, unknown>; dots: [string, string[], unknown][] };

/** Index of accepted flag spellings → property name. Colliding properties are left out. */
export function flagIndex(schema: Schema) {
  const index = new Map<string, string>();
  const shadowed: string[] = [];
  for (const prop of Object.keys(schema.properties ?? {})) {
    if (RESERVED.has(kebab(prop)) || RESERVED.has(prop)) { shadowed.push(prop); continue; }
    index.set(kebab(prop), prop);
    index.set(prop, prop);
  }
  return { index, shadowed };
}

export function parseFlags(argv: string[], schema: Schema): Parsed {
  const { index } = flagIndex(schema);
  const props: Record<string, Schema> = schema.properties ?? {};
  const globals: Parsed["globals"] = {};
  const args: Record<string, unknown> = {};
  const dots: Parsed["dots"] = [];
  const validFlags = () => `flags: ${[...new Set(index.values())].map(p => `--${kebab(p)}`).join(", ") || "none"}; run with --help`;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--") || token === "--") throw usage(`unexpected argument "${token}"`, ["Tool parameters are flags: --name value"]);
    let body = token.slice(2);
    let inline: string | undefined;
    const eq = body.indexOf("=");
    if (eq >= 0) { inline = body.slice(eq + 1); body = body.slice(0, eq); }
    const next = () => {
      if (inline !== undefined) return inline;
      const value = argv[++i];
      if (value === undefined) throw usage(`--${body} needs a value`);
      return value;
    };
    if (RESERVED.has(body)) {
      globals[body] = BOOLEAN_GLOBALS.has(body) ? (inline === undefined ? true : parseBool(inline, `--${body}`)) : next();
      continue;
    }
    const dot = body.indexOf(".");
    const head = dot >= 0 ? body.slice(0, dot) : body;
    const prop = index.get(head);
    if (prop === undefined) {
      const negated = dot < 0 && head.startsWith("no-") ? index.get(head.slice(3)) : undefined;
      if (negated && typeOf(props[negated]) === "boolean" && inline === undefined) { args[negated] = false; continue; }
      throw usage(`unknown flag --${head}`, [validFlags()]);
    }
    const schemaOf = props[prop];
    if (dot >= 0) {
      const path = body.slice(dot + 1).split(".");
      let leaf: Schema | undefined = schemaOf;
      for (const key of path) leaf = leaf?.properties?.[key];
      const flag = `--${body}`;
      dots.push([prop, path, typeOf(leaf) === "boolean" && inline === undefined ? true : coerce(leaf, next(), flag)]);
      continue;
    }
    const type = typeOf(schemaOf);
    if (type === "boolean") { args[prop] = inline === undefined ? true : parseBool(inline, `--${body}`); continue; }
    const raw = next();
    if (type === "array" && scalar(typeOf(schemaOf!.items)) && !raw.startsWith("[")) {
      const list = Array.isArray(args[prop]) ? args[prop] as unknown[] : (args[prop] = []) as unknown[];
      list.push(coerce(schemaOf!.items, raw, `--${body}`));
      continue;
    }
    args[prop] = coerce(schemaOf, raw, `--${body}`);
  }
  return { globals, args, dots };
}

/** Merge order: --arg-file < --json < flags < dot-flags. */
export function mergeArgs(parsed: Parsed): Record<string, unknown> {
  const fromFile = parsed.globals["arg-file"] ? readJsonFile(String(parsed.globals["arg-file"]), "--arg-file") : {};
  let fromJson: unknown = {};
  if (parsed.globals.json !== undefined) {
    try { fromJson = JSON.parse(String(parsed.globals.json)); } catch (error) { throw usage(`--json: ${(error as Error).message}`); }
  }
  for (const [flag, value] of [["--arg-file", fromFile], ["--json", fromJson]] as const)
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw usage(`${flag} must be a JSON object`);
  const merged: Record<string, any> = structuredClone({ ...fromFile as object, ...fromJson as object, ...parsed.args });
  for (const [prop, path, value] of parsed.dots) {
    let target = merged[prop] !== null && typeof merged[prop] === "object" && !Array.isArray(merged[prop]) ? merged[prop] : (merged[prop] = {});
    for (const key of path.slice(0, -1)) target = target[key] !== null && typeof target[key] === "object" ? target[key] : (target[key] = {});
    target[path.at(-1)!] = value;
  }
  return merged;
}

const firstSentence = (text: string) => (/^(.+?[.!?])(\s+[A-Z(`*]|\s*$)/s.exec(text.trim())?.[1] ?? text.trim()).replace(/\s+/g, " ");
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
export const summaryOf = (description: string | undefined, n = 100) => clip(firstSentence(description ?? ""), n);

function placeholder(schema: Schema | undefined): string {
  const type = typeOf(schema);
  if (Array.isArray(schema?.enum)) return schema!.enum.length <= 8 ? schema!.enum.join("|") : `<one of ${schema!.enum.length}>`;
  if (type === "boolean") return "";
  if (type === "string") return "<text>";
  if (type === "integer") return "<int>";
  if (type === "number") return "<n>";
  if (type === "array") return scalar(typeOf(schema!.items)) ? `${placeholder(schema!.items)}…` : "<json>|@file";
  return "<json>|@file";
}

export function toolHelp(o: { bin: string; connector: string; short: string; schema: Schema; description?: string; cls: string; reason: string; timeParams: string[]; full: boolean }) {
  const props: Record<string, Schema> = o.schema.properties ?? {};
  const required = new Set<string>(o.schema.required ?? []);
  const { shadowed } = flagIndex(o.schema);
  const names = Object.keys(props).filter(p => !shadowed.includes(p)).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const lines = names.map(prop => {
    const s = props[prop]!;
    const left = `--${kebab(prop)} ${placeholder(s)}`.trim() + (typeOf(s) === "boolean" ? ` / --no-${kebab(prop)}` : "");
    const desc = (required.has(prop) ? "(required) " : "") + (o.full ? (s.description ?? "").replace(/\s+/g, " ") : summaryOf(s.description, 90))
      + (o.timeParams.includes(prop) ? " · accepts today, -2d, 2026-11-03, monday 9am" : "");
    return `  ${left.padEnd(32)} ${desc}`.trimEnd();
  });
  const req = names.filter(p => required.has(p)).map(p => `--${kebab(p)} ${placeholder(props[p])}`.trim()).join(" ");
  return [
    `usage: ${o.bin} ${o.connector} ${o.short}${req ? ` ${req}` : ""} [flags]`,
    `class: ${o.cls} (${o.reason})`,
    `summary: ${o.full ? (o.description ?? "").trim() : summaryOf(o.description, 200)}`,
    `flags[${lines.length}]:`,
    ...lines,
    ...(shadowed.length ? [`only via --json (names clash with global flags): ${shadowed.join(", ")}`] : []),
    `global: --json '<obj>' | --arg-file <path|-> | --select a,b.c | --where '<expr>' | --items <path> | --out text|toon|json|md|raw | --deadline 30s | --full | --plan | --as <profile>${o.cls === "write" ? " | --write --write-key <k> --expect-hash sha256:<hex>" : ""}`,
    "",
  ].join("\n");
}
