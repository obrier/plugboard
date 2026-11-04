// Everything that differs between macOS, Linux, WSL and Windows lives here.
// Each function takes a context (platform, env, home, file checks) so tests can
// exercise every platform from any machine; callers use the real one by default.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Saves a record of a result a command already has (doctor's last run, usage counts). Best effort: a folder
 * it can't write, as in an agent's sandbox, must not fail the command. Returns why it wasn't saved, if it wasn't. */
export function saveRecord(path: string, write: () => void = () => {}): string | undefined {
  try { write(); return undefined; } catch (error) { return `${path}: ${(error as Error).message}`; }
}
export function saveJson(path: string, value: unknown): string | undefined {
  return saveRecord(path, () => { mkdirSync(posix.dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); });
}

export type Ctx = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
};
export const realCtx = (): Ctx => ({
  platform: process.platform, env: process.env, home: homedir(), exists: existsSync, realpath: path => realpathSync(path),
});
const pathFor = (c: Ctx) => (c.platform === "win32" ? win32 : posix);

/** WSL is Linux; it is detected by its distro variable or interop handlers, not /proc/version
 * (containers running inside WSL inherit that and would be misdetected). */
export const isWSL = (c = realCtx()) => c.platform === "linux" && Boolean(
  c.env.WSL_DISTRO_NAME
  || c.exists("/proc/sys/fs/binfmt_misc/WSLInterop")
  || c.exists("/proc/sys/fs/binfmt_misc/WSLInterop-Late"),
);

export const platformLabel = (c = realCtx(), arch = process.arch) =>
  isWSL(c) ? `wsl-${arch}${c.env.WSL_DISTRO_NAME ? ` (${c.env.WSL_DISTRO_NAME})` : ""}` : `${c.platform === "win32" ? "windows" : c.platform}-${arch}`;

export function expandHome(path: string, c = realCtx()) {
  if (path === "~") return c.home;
  return path.startsWith("~/") || path.startsWith("~\\") ? pathFor(c).join(c.home, path.slice(2)) : path;
}
export const collapseHome = (path: string, c = realCtx()) => (path.startsWith(c.home) ? `~${path.slice(c.home.length)}` : path);

/** Config, cache and state directories. Like gh: XDG on Linux, WSL and macOS (~/.config, not
 * ~/Library), AppData on Windows. Without XDG variables, these are the paths used since v0.1. */
export function dirs(c = realCtx()) {
  const p = pathFor(c);
  if (c.platform === "win32") {
    const roaming = c.env.APPDATA || p.join(c.home, "AppData", "Roaming");
    const local = c.env.LOCALAPPDATA || p.join(c.home, "AppData", "Local");
    return { config: p.join(roaming, "plugboard"), cache: p.join(local, "plugboard", "cache"), state: p.join(local, "plugboard", "state") };
  }
  // The XDG spec says relative values are invalid and must be ignored.
  const xdg = (value: string | undefined, fallback: string) => (value && p.isAbsolute(value) ? value : p.join(c.home, fallback));
  return {
    config: p.join(xdg(c.env.XDG_CONFIG_HOME, ".config"), "plugboard"),
    cache: p.join(xdg(c.env.XDG_CACHE_HOME, ".cache"), "plugboard"),
    state: p.join(xdg(c.env.XDG_STATE_HOME, p.join(".local", "state")), "plugboard"),
  };
}

// Explicit overrides win (tests use them).
export const cacheDir = (c = realCtx()) => (c.env.PLUGBOARD_CACHE ? expandHome(c.env.PLUGBOARD_CACHE, c) : dirs(c).cache);
export const stateDir = (c = realCtx()) => (c.env.PLUGBOARD_STATE ? expandHome(c.env.PLUGBOARD_STATE, c) : dirs(c).state);
/** Full results written for agents (batch --axi, cut single calls): private, kept a day. */
export const resultsDir = (c = realCtx()) => pathFor(c).join(stateDir(c), "results");
export const policyPath = (c = realCtx()) =>
  (c.env.PLUGBOARD_POLICY ? expandHome(c.env.PLUGBOARD_POLICY, c) : pathFor(c).join(dirs(c).config, "policy.toml"));

export const transformsPath = (c = realCtx()) =>
  (c.env.PLUGBOARD_TRANSFORMS ? expandHome(c.env.PLUGBOARD_TRANSFORMS, c) : pathFor(c).join(dirs(c).config, "transforms.toml"));

/** Claude Code's own config directory: ~/.claude on every OS, unless CLAUDE_CONFIG_DIR moves it. */
export const claudeConfigDir = (c = realCtx()) =>
  (c.env.CLAUDE_CONFIG_DIR ? expandHome(c.env.CLAUDE_CONFIG_DIR, c) : pathFor(c).join(c.home, ".claude"));

/** Directories on PATH that belong to Windows, seen from WSL through interop (/mnt/c/...). */
const interopDir = (dir: string) => /^\/mnt\/[a-z](\/|$)/i.test(dir);

/** The claude binary: PLUGBOARD_CLAUDE, then policy's claude_path, then the native installer's
 * location, then PATH. Under WSL, a Windows claude.exe reached through interop is never used: it
 * is a different install with a different login. Returns the native location when nothing is found,
 * so errors name the path we expected. */
export function findClaude(configured?: string, c = realCtx()): string {
  if (c.env.PLUGBOARD_CLAUDE) return expandHome(c.env.PLUGBOARD_CLAUDE, c);
  if (configured) return expandHome(configured, c);
  const p = pathFor(c);
  const windows = c.platform === "win32";
  const native = p.join(c.home, ".local", "bin", windows ? "claude.exe" : "claude");
  if (c.exists(native)) return native;
  const wsl = isWSL(c);
  const extensions = windows ? (c.env.PATHEXT || ".EXE;.CMD").split(";").filter(Boolean).map(e => e.toLowerCase()) : [""];
  for (const dir of (c.env.PATH ?? c.env.Path ?? "").split(windows ? ";" : ":")) {
    if (!dir || (wsl && interopDir(dir))) continue;
    for (const extension of extensions) {
      const candidate = p.join(dir, `claude${extension}`);
      if (c.exists(candidate)) return candidate;
    }
  }
  return native;
}

/** Under WSL: a Windows Claude Code visible through interop, worth naming when no Linux one exists. */
export function windowsClaudeFromWSL(c = realCtx()): string | undefined {
  if (!isWSL(c)) return undefined;
  for (const dir of (c.env.PATH ?? "").split(":")) {
    if (dir && interopDir(dir) && c.exists(posix.join(dir, "claude.exe"))) return posix.join(dir, "claude.exe");
  }
  return undefined;
}

/** Where Claude Code keeps installed versions, read from where the binary really points
 * (~/.local/bin/claude → ~/.local/share/claude/versions/2.1.312). Undefined for other installs. */
export function claudeVersionsDir(claude: string, c = realCtx()): string | undefined {
  let real: string;
  try { real = c.realpath(claude); } catch { return undefined; }
  const p = pathFor(c);
  return p.basename(p.dirname(real)) === "versions" ? p.dirname(real) : undefined;
}

/** On WSL, /mnt/<drive> is the Windows disk: slow, and it ignores file modes like the audit log's 0600. */
export const onWindowsDrive = (path: string, c = realCtx()) => isWSL(c) && interopDir(path);
