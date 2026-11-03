#!/usr/bin/env bun
// Local protocol fixture: no authentication or real tools; schema requests use loopback only.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
let statusCalls = 0;
const ids = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reply(id: string, payload: object, error?: string) {
  const line = JSON.stringify({ type: "control_response", response: {
    subtype: error ? "error" : "success", request_id: id,
    ...(error ? { error } : { response: payload }),
  } }) + "\n";
  // Force the client to handle partial frames.
  process.stdout.write(line.slice(0, 17));
  process.stdout.write(line.slice(17));
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "user") {
    const endpoint = new URL(process.env.ANTHROPIC_BASE_URL!);
    if (endpoint.hostname !== "127.0.0.1" || process.env.ENABLE_TOOL_SEARCH !== "false") process.exit(11);
    if (statusCalls < 3) process.exit(12);
    appendFileSync("schema-captures", "capture\n");
    const mode = existsSync("schema-mode") ? readFileSync("schema-mode", "utf8") : "ok";
    if (mode === "hang") { await new Promise(() => {}); }
    const names = ["mcp__claude_ai_Drive__search", "mcp__claude_ai_Mail__search"];
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: names }) + "\n");
    const response = await fetch(new URL("/v1/messages", endpoint), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: names.slice(mode === "missing" ? 1 : 0).map(name => ({
        name, description: `Search ${name.includes("Mail") ? "mail" : "drive"}`,
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      })) }),
    });
    const body = await response.json() as { error: { message: string } };
    process.stdout.write(JSON.stringify({ type: "result", result: `API Error: ${response.status} ${body.error.message}`,
      total_cost_usd: 0, usage: { input_tokens: mode === "usage" ? 1 : 0, output_tokens: 0 },
    }) + "\n");
    continue;
  }
  if (message.type === "control_cancel_request") {
    clearTimeout(timers.get(message.request_id));
    continue;
  }
  if (message.type !== "control_request") process.exit(10);
  const { request_id: id, request } = message;
  if (!uuid.test(id) || ids.has(id)) { reply(id, {}, "Invalid or reused UUID"); continue; }
  ids.add(id);
  switch (request.subtype) {
    case "initialize": reply(id, {}); break;
    case "mcp_status": {
      statusCalls++;
      // "empty": a logged-out Claude Code never loads any connector. "pending": one never settles.
      const statusMode = existsSync("status-mode") ? readFileSync("status-mode", "utf8") : "";
      // Claude Code can initially return no servers before loading connectors.
      if (statusCalls === 1 || statusMode === "empty") { reply(id, { mcpServers: [] }); break; }
      const drivePending = statusCalls === 2 || statusMode === "pending";
      reply(id, { mcpServers: [
        { name: "claude.ai Mail", status: "connected", scope: "claudeai",
          config: { type: "claudeai-proxy" }, tools: [
            { name: "search", annotations: { readOnly: true } },
          ] },
        { name: "claude.ai Drive", status: drivePending ? "pending" : "connected",
          scope: "claudeai", config: { type: "claudeai-proxy" },
          tools: drivePending ? [] : [{ name: "search", annotations: { readOnly: true } }] },
        { name: "claude.ai Slack", status: "needs-auth", scope: "claudeai" },
      ] });
      break;
    }
    case "mcp_call": {
      const args = request.arguments;
      if (args?.action === "exit") process.exit(3);
      if (args?.action === "fail") { reply(id, {}, "Connector needs authentication"); break; }
      timers.set(id, setTimeout(() => reply(id, {
        content: JSON.stringify({ tool: request.tool, value: args?.value }),
        structuredContent: { tool: request.tool, value: args?.value },
      }), args?.delay ?? 0));
      break;
    }
    case "get_session_cost": reply(id, { text: "zero" }); break;
    default: reply(id, {}, "Unsupported control request");
  }
}
