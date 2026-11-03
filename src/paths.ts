import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
export const expandHome = (path: string) => (path.startsWith("~/") ? join(home, path.slice(2)) : path);
export const collapseHome = (path: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

// Overridable for tests; defaults follow XDG.
export const cacheDir = () => expandHome(process.env.CONNECTORS_AXI_CACHE ?? "~/.cache/connectors-axi");
export const stateDir = () => expandHome(process.env.CONNECTORS_AXI_STATE ?? "~/.local/state/connectors-axi");
export const policyPath = () => expandHome(process.env.CONNECTORS_AXI_POLICY ?? "~/.config/connectors-axi/policy.toml");
