import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
export const expandHome = (path: string) => (path.startsWith("~/") ? join(home, path.slice(2)) : path);
export const collapseHome = (path: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

// Overridable for tests; defaults follow XDG.
export const cacheDir = () => expandHome(process.env.PLUGBOARD_CACHE ?? "~/.cache/plugboard");
export const stateDir = () => expandHome(process.env.PLUGBOARD_STATE ?? "~/.local/state/plugboard");
export const policyPath = () => expandHome(process.env.PLUGBOARD_POLICY ?? "~/.config/plugboard/policy.toml");
