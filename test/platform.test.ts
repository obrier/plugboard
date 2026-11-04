// Every platform's behaviour, simulated from any machine through an injected context.
import { describe, expect, test } from "bun:test";
import {
  claudeConfigDir, claudeVersionsDir, dirs, expandHome, findClaude, isWSL, onWindowsDrive, platformLabel, policyPath,
  windowsClaudeFromWSL, type Ctx,
} from "../src/platform";

const ctx = (platform: NodeJS.Platform, env: Record<string, string> = {}, files: string[] = [], links: Record<string, string> = {}): Ctx => ({
  platform, env, home: platform === "win32" ? "C:\\Users\\ana" : "/home/ana",
  exists: path => files.includes(path),
  realpath: path => { if (links[path]) return links[path]; if (files.includes(path)) return path; throw new Error("ENOENT"); },
});
const linux = (env = {}, files: string[] = [], links = {}) => ctx("linux", env, files, links);
const wsl = (env: Record<string, string> = {}, files: string[] = []) => ctx("linux", { WSL_DISTRO_NAME: "Ubuntu-24.04", ...env }, files);

describe("directories", () => {
  test("Linux, WSL and macOS: today's paths when XDG is unset", () => {
    for (const c of [linux(), wsl(), ctx("darwin")]) {
      expect(dirs(c)).toEqual({ config: "/home/ana/.config/plugboard", cache: "/home/ana/.cache/plugboard", state: "/home/ana/.local/state/plugboard" });
    }
    expect(policyPath(linux())).toBe("/home/ana/.config/plugboard/policy.toml");
  });
  test("XDG variables are honoured; relative ones are ignored, as the spec says", () => {
    expect(dirs(linux({ XDG_CONFIG_HOME: "/xdg/conf", XDG_CACHE_HOME: "/xdg/cache", XDG_STATE_HOME: "/xdg/state" })))
      .toEqual({ config: "/xdg/conf/plugboard", cache: "/xdg/cache/plugboard", state: "/xdg/state/plugboard" });
    expect(dirs(linux({ XDG_CONFIG_HOME: "relative/conf" })).config).toBe("/home/ana/.config/plugboard");
  });
  test("Windows: AppData, with fallbacks when the variables are missing", () => {
    expect(dirs(ctx("win32", { APPDATA: "C:\\Users\\ana\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }))).toEqual({
      config: "C:\\Users\\ana\\AppData\\Roaming\\plugboard",
      cache: "C:\\Users\\ana\\AppData\\Local\\plugboard\\cache",
      state: "C:\\Users\\ana\\AppData\\Local\\plugboard\\state",
    });
    expect(dirs(ctx("win32")).config).toBe("C:\\Users\\ana\\AppData\\Roaming\\plugboard");
    expect(policyPath(ctx("win32", { APPDATA: "D:\\roam" }))).toBe("D:\\roam\\plugboard\\policy.toml");
  });
  test("PLUGBOARD_* overrides win and expand ~", () => {
    expect(policyPath(linux({ PLUGBOARD_POLICY: "~/work/policy.toml", XDG_CONFIG_HOME: "/x" }))).toBe("/home/ana/work/policy.toml");
  });
  test("Claude Code's config dir: ~/.claude, or CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigDir(linux())).toBe("/home/ana/.claude");
    expect(claudeConfigDir(linux({ CLAUDE_CONFIG_DIR: "~/alt-claude" }))).toBe("/home/ana/alt-claude");
    expect(claudeConfigDir(ctx("win32"))).toBe("C:\\Users\\ana\\.claude");
  });
  test("expandHome handles ~, ~/ and ~\\", () => {
    expect(expandHome("~", linux())).toBe("/home/ana");
    expect(expandHome("~/a/b", linux())).toBe("/home/ana/a/b");
    expect(expandHome("~\\a", ctx("win32"))).toBe("C:\\Users\\ana\\a");
    expect(expandHome("/abs", linux())).toBe("/abs");
  });
});

describe("finding claude", () => {
  test("PLUGBOARD_CLAUDE, then policy's claude_path, then the native installer, then PATH", () => {
    expect(findClaude("/policy/claude", linux({ PLUGBOARD_CLAUDE: "/env/claude" }))).toBe("/env/claude");
    expect(findClaude("~/pinned/claude", linux())).toBe("/home/ana/pinned/claude");
    expect(findClaude(undefined, linux({ PATH: "/usr/bin" }, ["/home/ana/.local/bin/claude", "/usr/bin/claude"]))).toBe("/home/ana/.local/bin/claude");
    expect(findClaude(undefined, linux({ PATH: "/usr/local/bin:/usr/bin" }, ["/usr/bin/claude"]))).toBe("/usr/bin/claude");
  });
  test("nothing found: the native location, so errors name the expected path", () => {
    expect(findClaude(undefined, linux({ PATH: "/usr/bin" }))).toBe("/home/ana/.local/bin/claude");
  });
  test("WSL never picks a Windows claude.exe through interop", () => {
    const windowsBin = "/mnt/c/Users/ana/.local/bin";
    const c = wsl({ PATH: `/usr/bin:${windowsBin}` }, [`${windowsBin}/claude.exe`, `${windowsBin}/claude`]);
    expect(findClaude(undefined, c)).toBe("/home/ana/.local/bin/claude");
    expect(windowsClaudeFromWSL(c)).toBe(`${windowsBin}/claude.exe`);
    expect(findClaude(undefined, wsl({ PATH: `${windowsBin}:/usr/bin` }, [`${windowsBin}/claude`, "/usr/bin/claude"]))).toBe("/usr/bin/claude");
  });
  test("plain Linux may use /mnt (it's just a mount there)", () => {
    expect(findClaude(undefined, linux({ PATH: "/mnt/c/tools" }, ["/mnt/c/tools/claude"]))).toBe("/mnt/c/tools/claude");
    expect(windowsClaudeFromWSL(linux({ PATH: "/mnt/c/x" }, ["/mnt/c/x/claude.exe"]))).toBeUndefined();
  });
  test("Windows: claude.exe in the native location, else PATH with PATHEXT", () => {
    expect(findClaude(undefined, ctx("win32", {}, ["C:\\Users\\ana\\.local\\bin\\claude.exe"]))).toBe("C:\\Users\\ana\\.local\\bin\\claude.exe");
    expect(findClaude(undefined, ctx("win32", { PATH: "C:\\npm;C:\\tools", PATHEXT: ".COM;.EXE;.CMD" }, ["C:\\npm\\claude.cmd"]))).toBe("C:\\npm\\claude.cmd");
  });
  test("the versions directory comes from where the binary really points", () => {
    const c = linux({}, [], { "/home/ana/.local/bin/claude": "/home/ana/.local/share/claude/versions/2.1.312" });
    expect(claudeVersionsDir("/home/ana/.local/bin/claude", c)).toBe("/home/ana/.local/share/claude/versions");
    expect(claudeVersionsDir("/usr/bin/claude", linux({}, ["/usr/bin/claude"]))).toBeUndefined();
    expect(claudeVersionsDir("/missing", linux())).toBeUndefined();
  });
});

describe("WSL detection", () => {
  test("by WSL_DISTRO_NAME or the interop handlers, never on other platforms", () => {
    expect(isWSL(wsl())).toBe(true);
    expect(isWSL(linux({}, ["/proc/sys/fs/binfmt_misc/WSLInterop-Late"]))).toBe(true);
    expect(isWSL(linux({}, ["/proc/sys/fs/binfmt_misc/WSLInterop"]))).toBe(true);
    expect(isWSL(linux())).toBe(false);
    expect(isWSL(ctx("darwin", { WSL_DISTRO_NAME: "x" }))).toBe(false);
  });
  test("labels and the Windows-drive warning", () => {
    expect(platformLabel(wsl(), "x64")).toBe("wsl-x64 (Ubuntu-24.04)");
    expect(platformLabel(linux(), "arm64")).toBe("linux-arm64");
    expect(platformLabel(ctx("win32"), "x64")).toBe("windows-x64");
    expect(onWindowsDrive("/mnt/c/Users/ana/state", wsl())).toBe(true);
    expect(onWindowsDrive("/home/ana/.local/state/plugboard", wsl())).toBe(false);
    expect(onWindowsDrive("/mnt/c/x", linux())).toBe(false);
  });
});
