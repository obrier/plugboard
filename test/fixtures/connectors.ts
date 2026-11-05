// The connectors test/fixtures/fake-claude.ts serves, captured into a cache as `plugboard refresh` would:
// Slack (connected, by its connector ID) and Gmail. Shared by the CLI's and the library's tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeCapture } from "../../src/cache";

export function writeConnectorCache(cache: string) {
  const servers = [
    { name: "claude.ai Slack", status: "connected", config: { type: "claudeai-proxy", url: "https://mcp.slack.com/mcp", id: "mcpsrv_01slack" }, tools: [
      { name: "slack_search_public", annotations: { readOnly: true } }, { name: "slack_send_message" },
      { name: "slack_delete_message", annotations: { destructive: true } }, { name: "slack_create_note" }] },
    { name: "claude.ai Gmail", status: "connected", tools: [{ name: "list_labels", annotations: { readOnly: true } }] },
  ];
  const schemas = [
    { name: "mcp__claude_ai_Slack__slack_search_public", inputSchema: { type: "object", properties: { query: { type: "string" }, after: { type: "string" }, limit: { type: "integer" } } } },
    { name: "mcp__claude_ai_Slack__slack_send_message", inputSchema: { type: "object", required: ["channel_id", "message"], properties: { channel_id: { type: "string" }, message: { type: "string" } } } },
    { name: "mcp__claude_ai_Slack__slack_delete_message", inputSchema: { type: "object", properties: { ts: { type: "string" } } } },
    { name: "mcp__claude_ai_Slack__slack_create_note", inputSchema: { type: "object", properties: { text: { type: "string" }, idempotency_key: { type: "string" } } } },
    { name: "mcp__claude_ai_Gmail__list_labels", inputSchema: { type: "object", properties: {} } },
  ];
  const { index, manifests } = mergeCapture(undefined, servers as never, schemas);
  mkdirSync(join(cache, "manifests"), { recursive: true });
  writeFileSync(join(cache, "index.json"), JSON.stringify({ ...index, testedVersions: ["9.9.9"] }));
  for (const m of manifests) writeFileSync(join(cache, "manifests", `${m.id}.json`), JSON.stringify(m));
}
