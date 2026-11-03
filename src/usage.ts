import { existsSync, readdirSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, manifestIds, sourceName } from "./cache";
import { cacheDir, expandHome } from "./paths";

export type Usage = { generatedAt: string; days: number; files: number; calls: number; counts: Record<string, number> };

export const usagePath = () => join(cacheDir(), "usage.json");
export const loadUsage = (): Usage | undefined => (existsSync(usagePath()) ? JSON.parse(readFileSync(usagePath(), "utf8")) : undefined);
const transcriptsDir = () => expandHome(process.env.PLUGBOARD_TRANSCRIPTS ?? "~/.claude/projects");

function transcripts(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(f => f.endsWith(".jsonl"))
    .map(f => join(dir, f))
    .filter(f => { try { return statSync(f).mtimeMs >= since; } catch { return false; } });
}

/** Connector tool calls in Claude Code transcripts, counted as `connector:tool`.
 * CLI sessions name tools `mcp__claude_ai_Slack__…`; desktop sessions use a UUID instead of the
 * connector name, so those are matched by tool name and skipped when the name is ambiguous. */
export function scanUsage(days = 30): Usage {
  const byPrefix = new Map<string, string>(); // full source name → connector:tool
  const byTool = new Map<string, string[]>(); // bare tool name → connector:tool candidates
  for (const id of manifestIds()) {
    const manifest = loadManifest(id);
    for (const tool of manifest?.tools ?? []) {
      const key = `${id}:${tool.name}`;
      byPrefix.set(sourceName(manifest!.connectorName, tool.name), key);
      byTool.set(tool.name, [...(byTool.get(tool.name) ?? []), key]);
    }
  }
  const files = transcripts(transcriptsDir(), Date.now() - days * 86_400_000);
  const counts: Record<string, number> = {};
  let calls = 0;
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      // Only real calls: assistant messages carrying tool_use blocks, not tool lists or reminders.
      if (!line.includes('"tool_use"') || !line.includes('"mcp__')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content) {
        if (block?.type !== "tool_use" || typeof block.name !== "string" || !block.name.startsWith("mcp__")) continue;
        const bare = block.name.slice(block.name.lastIndexOf("__") + 2);
        const key = byPrefix.get(block.name) ?? (byTool.get(bare)?.length === 1 ? byTool.get(bare)![0] : undefined);
        if (!key) continue;
        counts[key] = (counts[key] ?? 0) + 1;
        calls++;
      }
    }
  }
  const usage = { generatedAt: new Date().toISOString(), days, files: files.length, calls, counts };
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(usagePath(), JSON.stringify(usage));
  return usage;
}
