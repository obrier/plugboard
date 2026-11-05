#!/usr/bin/env bun
// Fake Claude Code for CLI tests: control protocol only, no network, no account.
// Behaviour is steered by files in FAKE_DIR; every mcp_call is appended to FAKE_DIR/calls.jsonl.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_DIR!;
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
const flag = (name: string) => existsSync(join(dir, name));
// As mcp_status reports a claude.ai connector: through Anthropic's proxy, by its ID.
const proxy = (url: string, id: string) => ({ type: "claudeai-proxy", url, id });
const reply = (id: string, payload: object, error?: string) => process.stdout.write(JSON.stringify({ type: "control_response",
  response: { subtype: error ? "error" : "success", request_id: id, ...(error ? { error } : { response: payload }) } }) + "\n");
const count = (name: string) => {
  const path = join(dir, name);
  const n = (existsSync(path) ? Number(readFileSync(path, "utf8")) : 0) + 1;
  writeFileSync(path, String(n));
  return n;
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type !== "control_request") continue;
  const { request_id: id, request } = message;
  switch (request.subtype) {
    case "initialize": reply(id, {}); break;
    case "mcp_status": reply(id, { mcpServers: [
      { name: "claude.ai Slack", status: "connected", config: proxy("https://mcp.slack.com/mcp", "mcpsrv_01slack"), tools: [
        { name: "slack_search_public", annotations: { readOnly: true } },
        { name: "slack_send_message" },
        { name: "slack_delete_message", annotations: { destructive: true } },
        { name: "slack_create_note" },
      ] },
      { name: "claude.ai Gmail", status: flag("gmail-connected") ? "connected" : "needs-auth", config: proxy("https://gmailmcp.googleapis.com/mcp/v1", "mcpsrv_01gmail"), tools: [] },
    ] }); break;
    case "mcp_call": {
      appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ tool: request.tool, args: request.arguments }) + "\n");
      const mode = request.arguments?.query ?? request.arguments?.message;
      if (mode === "hang") break; // never answers: the caller's deadline fires
      if (mode === "ratelimit" && count("ratelimit-count") <= 2) { reply(id, {}, "429 Too Many Requests"); break; }
      if (mode === "auth") { reply(id, {}, "invalid_auth"); break; }
      if (mode === "iserror") { reply(id, { isError: true, content: [{ type: "text", text: "channel_not_found" }] }); break; }
      if (request.tool.endsWith("send_message")) { reply(id, { content: [{ type: "text", text: JSON.stringify({ ok: true, ts: "1762243803.1234" }) }] }); break; }
      reply(id, { content: [{ type: "text", text: JSON.stringify({ results: `# Results for ${mode}`, matches: [{ user: "jose", n: 1 }, { user: "ana", n: 2 }] }) }] });
      break;
    }
    case "get_session_cost": reply(id, { text: flag("cost")
      ? "Total cost:            $0.0100\nUsage:                 10 input, 0 output, 0 cache read, 0 cache write"
      : "Total cost:            $0.0000\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write" }); break;
    default: reply(id, {}, "Unsupported control request");
  }
}
