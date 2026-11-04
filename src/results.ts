import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultsDir } from "./platform";

const DAY = 86_400_000;

/** A new private folder for one run's results (0700). Runs older than a day are removed first:
 * results hold mail and chat, so they don't stay on disk. */
export function newRun(prefix: "b" | "r"): string {
  const base = resultsDir();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    try { if (Date.now() - statSync(path).mtimeMs > DAY) rmSync(path, { recursive: true, force: true }); } catch { /* removed meanwhile */ }
  }
  return mkdtempSync(join(base, `${prefix}-`));
}

/** Writes one result file (0600) and returns its path. */
export function writePrivate(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600, flag: "wx" }); // never over another result
  return path;
}
