import * as chrono from "chrono-node";

/** Read `today`, `-2d`, `+7d`, `2026-11-03`, unix seconds/ms, ISO, or natural language (chrono). Local time zone. */
export function parseTime(input: string, now = new Date()): Date | undefined {
  const s = input.trim().toLowerCase();
  if (/^\d{9,10}(\.\d+)?$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s));
  const rel = /^([+-])(\d+)([mhdw])$/.exec(s);
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[3] as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() + (rel[1] === "-" ? -1 : 1) * Number(rel[2]) * unit);
  }
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  if (s === "now") return now;
  if (s === "today") return day(0);
  if (s === "yesterday") return day(-1);
  if (s === "tomorrow") return day(1);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  if (/^\d{4}-\d{2}-\d{2}t/.test(s) && !Number.isNaN(Date.parse(input))) return new Date(Date.parse(input));
  return chrono.parseDate(input, now) ?? undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
function rfc3339(d: Date) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function formatTime(d: Date, format: string): string | number {
  switch (format) {
    case "unix": return Math.floor(d.getTime() / 1000);
    case "unix-ms": return d.getTime();
    case "date": return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    default: return rfc3339(d);
  }
}
