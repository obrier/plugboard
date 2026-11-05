import { encode } from "@toon-format/toon";
import { compileExpression } from "filtrex";
import { fail } from "./errors";
import { unwrap } from "./unwrap";
import { newRun, writePrivate } from "./results";

// --- projection and filtering, from slax (src/fields.ts, src/filter.ts) ---------------

function getPath(obj: any, dotted: string): any {
  let cur = obj;
  for (const k of dotted.split(".")) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}
function setPath(target: any, dotted: string, value: any) {
  const parts = dotted.split(".");
  let cur = target;
  for (const k of parts.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; }
  cur[parts.at(-1)!] = value;
}
export const parseList = (spec: string | undefined) => (spec ? spec.split(",").map(s => s.trim()).filter(Boolean) : []);
function projectOne(row: any, fields: string[]) {
  if (row == null || typeof row !== "object") return row;
  const out: any = {};
  for (const f of fields) { const v = getPath(row, f); if (v !== undefined) setPath(out, f, v); }
  return out;
}
export const project = (value: any, fields: string[]) =>
  !fields.length ? value : Array.isArray(value) ? value.map(r => projectOne(r, fields)) : projectOne(value, fields);

const NULL_SENTINEL = "__null__"; // filtrex can't compare to a literal null
export function compileFilter(expr: string): (row: any) => boolean {
  let fn: (row: any) => any;
  try {
    fn = compileExpression(expr, {
      customProp: (name: string, _get: unknown, row: any) => {
        if (name === "null") return NULL_SENTINEL;
        if (name === "true") return true;
        if (name === "false") return false;
        const v = getPath(row, name);
        return v == null ? NULL_SENTINEL : v;
      },
      extraFunctions: {
        now: () => Math.floor(Date.now() / 1000),
        ts: (s: string) => { const d = new Date(s).getTime(); return Number.isNaN(d) ? 0 : Math.floor(d / 1000); },
        isnull: (v: any) => v === NULL_SENTINEL || v == null,
        notnull: (v: any) => !(v === NULL_SENTINEL || v == null),
      },
    });
  } catch (error) { throw fail("VALIDATION_ERROR", `--where: ${(error as Error).message}`); }
  return row => {
    try { const r = fn(row); return r && typeof r === "object" && "I18N_STRING" in r ? false : Boolean(r); } catch { return false; }
  };
}

/** The list --where and --select apply to: --items <path>, a top-level array, or the only array field. */
function locate(value: any, path?: string): string | null | undefined {
  if (path) {
    if (!Array.isArray(getPath(value, path))) throw fail("VALIDATION_ERROR", `--items ${path} is not a list in this result`);
    return path;
  }
  if (Array.isArray(value)) return null; // the root itself
  if (value && typeof value === "object") {
    const arrays = Object.keys(value).filter(k => Array.isArray(value[k]));
    if (arrays.length === 1) return arrays[0]!;
    if (arrays.length > 1) throw fail("VALIDATION_ERROR", `The result has several lists (${arrays.join(", ")}): pass --items <one of them>`);
  }
  return undefined;
}

export function shape(value: any, o: { select?: string[]; where?: string; items?: string }): any {
  if (!o.select?.length && !o.where) return value;
  const at = locate(value, o.items);
  if (at === undefined) {
    if (o.where) throw fail("VALIDATION_ERROR", "--where needs a list: pass --items <path>");
    return project(value, o.select ?? []);
  }
  let list: any[] = at === null ? value : getPath(value, at);
  if (o.where) list = list.filter(compileFilter(o.where));
  list = project(list, o.select ?? []);
  if (at === null) return list;
  const out = structuredClone(value);
  setPath(out, at, list);
  return out;
}

/** Interactive formats only: JSON for scripts is never cut. */
export function truncate(value: unknown, limit = 1500): { value: unknown; cut: number } {
  let cut = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && v.length > limit) { cut++; return `${v.slice(0, limit - 1)}…`; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), cut };
}

/** A result as a file, keeping every key. Text (Slack's markdown, Sentry's and Datadog's text) stays text, not
 * one escaped string, because Claude Code's Read cuts lines over 2,000 chars: a string, or an object of strings with
 * exactly one multi-line field, written after the other fields as `key: value` lines. Anything else is TOON. */
export function fileOf(value: unknown): { ext: string; text: string } {
  if (typeof value === "string") return { ext: "md", text: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    const long = entries.filter(([, v]) => typeof v === "string" && v.includes("\n"));
    if (long.length === 1 && entries.every(([, v]) => typeof v === "string" && !(v.includes("\n") && v !== long[0]![1]))) {
      const header = entries.filter(([k]) => k !== long[0]![0]).map(([k, v]) => `${k}: ${v}`);
      return { ext: "md", text: [...(header.length ? [header.join("\n")] : []), long[0]![1] as string].join("\n\n") };
    }
  }
  return { ext: "toon", text: encode(value) };
}
/** Best effort: a result that can't be written (disk full, no folder) must not fail a call that succeeded. */
function spill(value: unknown): string | undefined {
  try {
    const { ext, text } = fileOf(value);
    return writePrivate(newRun("r"), `result.${ext}`, text);
  } catch { return undefined; }
}

/** The length of a result's one obvious list (as --where finds it), if it has one. */
export function itemCount(value: unknown): number | undefined {
  try {
    const at = locate(value);
    return at === undefined ? undefined : (at === null ? (value as unknown[]) : getPath(value, at)).length;
  } catch { return undefined; }
}

/** --out md: a string result, or an object holding one string (Slack's {"results": "# …"}). */
export function markdownOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // Slack: {"results": "# …", "pagination_info": "…"}
    const values = Object.values(value);
    if (values.length && values.every(v => typeof v === "string")) return (values as string[]).join("\n\n");
  }
  return undefined;
}

/** Plain output for people; AXI/TOON for agents: `--axi`, PLUGBOARD_AXI=1, or inside Claude Code (CLAUDECODE set),
 * the same signal the write refusal reads. PLUGBOARD_AXI=0 turns it off there. */
export const mode = { axi: process.env.PLUGBOARD_AXI === "1" || (!!process.env.CLAUDECODE && process.env.PLUGBOARD_AXI !== "0") };
export const OUT_FORMATS = ["text", "toon", "json", "md", "raw"];
export const defaultFormat = () => (mode.axi ? "toon" : "text");

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
function table(rows: unknown[], indent: string): string[] {
  if (!rows.every(r => r && typeof r === "object" && !Array.isArray(r))) return rows.map(r => `${indent}- ${cell(r)}`);
  const cols = [...new Set(rows.flatMap(r => Object.keys(r as object)))];
  const grid = [cols.map(c => c.toUpperCase()), ...rows.map(r => cols.map(c => cell((r as any)[c]).replace(/\s+/g, " ")))];
  const widths = cols.map((_, i) => Math.max(...grid.map(row => row[i]!.length)));
  return grid.map(row => indent + row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join("  "));
}
/** Human-readable rendering of any command output: `key: value` lines, lists as aligned tables, hints last. */
export function plainText(value: unknown, indent = ""): string {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return table(value, indent).join("\n");
  const lines: string[] = [];
  let hints: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (key === "help") { hints = Array.isArray(v) ? v.map(String) : [String(v)]; continue; }
    if (v === null || typeof v !== "object") lines.push(`${indent}${key}: ${v ?? "-"}`);
    else if (Array.isArray(v) && v.every(x => x === null || typeof x !== "object")) lines.push(`${indent}${key}: ${v.length ? v.join(", ") : "-"}`);
    else if (Array.isArray(v) && !v.length) lines.push(`${indent}${key}: -`);
    else lines.push(`${indent}${key}:`, ...(Array.isArray(v) ? table(v, `${indent}  `) : [plainText(v, `${indent}  `)]));
  }
  if (hints.length) lines.push(...hints.map(h => `${indent}hint: ${h}`));
  return lines.join("\n");
}
export function render(o: { raw: unknown; value: unknown; format: string; full: boolean; header?: Record<string, unknown> }): string | Record<string, unknown> {
  if (o.format === "raw") return JSON.stringify(o.raw);
  if (o.format === "json") return JSON.stringify(o.value);
  if (o.format === "text") {
    const body = markdownOf(o.value) ?? JSON.stringify(o.value, null, 2);
    return o.header ? `${plainText(o.header)}\n${body}` : body;
  }
  const { value, cut } = o.full ? { value: o.value, cut: 0 } : truncate(o.value);
  // Nothing is lost: the full result goes to a private file the hint names.
  const file = cut ? spill(o.value) : undefined;
  const help = cut ? [`${cut} long string(s) cut at 1500 chars${file ? `; full result: ${file} (or add --full)` : ": add --full"}`] : [];
  if (o.format === "md") {
    const md = markdownOf(value);
    if (md !== undefined) return md + (help.length ? `\n\n(${help[0]})` : "");
  }
  return { ...o.header, result: value, ...(help.length ? { help } : {}) };
}
