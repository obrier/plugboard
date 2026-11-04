import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureConnectorSchemas } from "./bridge/capture";
import type { ConnectorServer } from "./bridge/client";
import { claudePath, claudeVersion, connect } from "./claude";
import { fail } from "./errors";
import { cacheDir } from "./platform";
import type { Policy } from "./policy";

export type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
/** A connector's tool as cached: the bridge's ConnectorManifest tool shape. */
export type ManifestTool = { name: string; sourceName: string; description?: string; inputSchema: Record<string, any>; annotations?: Annotations };
export type Manifest = { id: string; connectorName: string; tools: ManifestTool[]; capturedAt: string; hidden?: string[] };
export type IndexEntry = { name: string; status: string; capturedAt?: string; staleSince?: string; tools: number; read: number; write: number; sha256?: string };
export type CacheIndex = { format: 1; claude?: string; testedVersions: string[]; connectors: Record<string, IndexEntry> };

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
export const connectorId = (serverName: string) =>
  serverName.replace(/^claude\.ai\s+/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "connector";
export const sourceName = (serverName: string, toolName: string) => `mcp__${normalize(serverName)}__${normalize(toolName)}`;
export function annotationsOf(tool: ConnectorServer["tools"][number]): Annotations | undefined {
  const a = tool.annotations;
  if (!a) return undefined;
  return {
    ...(a.readOnly === undefined ? {} : { readOnlyHint: a.readOnly }),
    ...(a.destructive === undefined ? {} : { destructiveHint: a.destructive }),
    ...(a.openWorld === undefined ? {} : { openWorldHint: a.openWorld }),
  };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path); // atomic: a reader never sees half a manifest
}
const readJson = <T>(path: string): T | undefined => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);

export const loadIndex = () => readJson<CacheIndex>(join(cacheDir(), "index.json"));
export const saveIndex = (index: CacheIndex) => writeJson(join(cacheDir(), "index.json"), index);
export const loadManifest = (id: string) => readJson<Manifest>(join(cacheDir(), "manifests", `${id}.json`));
export const manifestIds = () => (existsSync(join(cacheDir(), "manifests")) ? readdirSync(join(cacheDir(), "manifests")).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)) : []);

/** Short CLI name: drop a leading `<connector>_` prefix, then kebab-case. */
export function shortName(id: string, toolName: string) {
  const prefix = `${id.replace(/-/g, "_")}_`;
  const rest = toolName.startsWith(prefix) && toolName.length > prefix.length ? toolName.slice(prefix.length) : toolName;
  return rest.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function findTool(manifest: Manifest, ref: string): ManifestTool | undefined {
  return manifest.tools.find(t => t.name === ref)
    ?? manifest.tools.find(t => shortName(manifest.id, t.name) === ref)
    ?? manifest.tools.find(t => t.name.replace(/_/g, "-").toLowerCase() === ref.toLowerCase());
}

export function nearNames(manifest: Manifest, ref: string, limit = 3) {
  const words = ref.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  return manifest.tools.map(t => shortName(manifest.id, t.name))
    .map(name => ({ name, score: words.filter(w => name.includes(w)).length }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.name);
}

const countClasses = (tools: ManifestTool[]) => {
  const read = tools.filter(t => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint !== true).length;
  return { tools: tools.length, read, write: tools.length - read };
};

export type RefreshResult = { updated: string[]; kept: { id: string; status: string }[]; hidden: number; claude?: string; tools: number };

/** Merge a fresh live snapshot and schema capture into the cache, per connector.
 * Auth can flip between two spawns (seen 3 Nov), so only connectors connected in both are replaced. */
export function mergeCapture(previous: CacheIndex | undefined, servers: ConnectorServer[], schemas: { name: string; description?: string; inputSchema: Record<string, unknown> }[], only?: string[], now = new Date().toISOString()) {
  const index: CacheIndex = previous ?? { format: 1, testedVersions: [], connectors: {} };
  const byName = new Map(schemas.map(s => [s.name, s]));
  const manifests: Manifest[] = [];
  const result: RefreshResult = { updated: [], kept: [], hidden: 0, tools: 0 };
  for (const server of servers) {
    const id = connectorId(server.name);
    if (only?.length && !only.includes(id)) continue;
    const tools: ManifestTool[] = [];
    const hidden: string[] = [];
    if (server.status === "connected") for (const tool of server.tools) {
      const schema = byName.get(sourceName(server.name, tool.name));
      if (!schema) { hidden.push(tool.name); continue; }
      const annotations = annotationsOf(tool);
      tools.push({ name: tool.name, sourceName: schema.name, ...(schema.description === undefined ? {} : { description: schema.description }),
        inputSchema: schema.inputSchema as Record<string, any>, ...(annotations ? { annotations } : {}) });
    }
    const old = index.connectors[id];
    if (server.status === "connected" && tools.length) {
      manifests.push({ id, connectorName: server.name, tools, capturedAt: now, ...(hidden.length ? { hidden } : {}) });
      index.connectors[id] = { name: server.name, status: "connected", capturedAt: now, ...countClasses(tools), sha256: sha256(tools) };
      result.updated.push(id);
      result.hidden += hidden.length;
      result.tools += tools.length;
    } else {
      index.connectors[id] = { ...(old ?? { tools: 0, read: 0, write: 0 }), name: server.name,
        status: server.status === "connected" ? "no-schemas" : server.status,
        ...(old?.capturedAt ? { staleSince: old.staleSince ?? now } : {}) };
      result.kept.push({ id, status: index.connectors[id]!.status });
    }
  }
  if (!only?.length) for (const [id, entry] of Object.entries(index.connectors))
    if (!servers.some(s => connectorId(s.name) === id)) index.connectors[id] = { ...entry, status: "absent", staleSince: entry.staleSince ?? now };
  return { index, manifests, result };
}

export async function refresh(policy: Policy, only?: string[]): Promise<RefreshResult> {
  const client = await connect(policy);
  try {
    // Discovery and capture run side by side: two spawns, ~3.5 s in total.
    const [servers, capture] = await Promise.all([
      client.waitForServers(),
      captureConnectorSchemas({ claudePath: claudePath(policy) }).catch(error => {
        throw fail("BRIDGE_BROKEN", `Schema capture failed: ${(error as Error).message}`, ["Run `plugboard doctor`"]);
      }),
    ]);
    const { index, manifests, result } = mergeCapture(loadIndex(), servers, capture.schemas, only);
    for (const manifest of manifests) writeJson(join(cacheDir(), "manifests", `${manifest.id}.json`), manifest);
    index.claude = claudeVersion(claudePath(policy));
    saveIndex(index);
    return { ...result, claude: index.claude };
  } finally {
    await client.close();
  }
}

export const toolHash = (tool: ManifestTool) => sha256(tool.inputSchema);
