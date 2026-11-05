// The direct session against a fake proxy (fetch) and a fake Claude Code: no network, no keychain.
import { afterEach, expect, test } from "bun:test";
import type { Manifest } from "../src/cache";
import { costGuard } from "../src/claude";
import { DirectSession, directEnabled, PROXY_ORIGIN, type Login } from "../src/direct";
import { invoke } from "../src/core";

const calendar: Manifest = {
  id: "google-calendar", connectorName: "claude.ai Google Calendar", capturedAt: "2026-11-05T00:00:00Z",
  server: { type: "claudeai-proxy", url: "https://calendarmcp.googleapis.com/mcp/v1", id: "mcpsrv_01cal" },
  tools: [{ name: "list_calendars", sourceName: "mcp__claude_ai_Google_Calendar__list_calendars", inputSchema: { type: "object" } }],
};
const login: Login = { accessToken: "secret-token", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference", "user:mcp_servers"] };
const RESULT = { content: [{ type: "text", text: '{"calendars":[]}' }] };
const CALL = { subtype: "mcp_call", tool: "mcp__claude_ai_Google_Calendar__list_calendars", arguments: {} };

type Sent = { url: string; headers: Headers; body: any };
function proxy(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const s = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
    sent.push(s);
    // Like fetch: a request still waiting rejects when its signal fires.
    return Promise.race([answer(s), new Promise<never>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))]);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const ok = (result: object = RESULT, sse = false) => (s: Sent) => sse
  ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: s.body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } })
  : Response.json({ jsonrpc: "2.0", id: s.body.id, result });

function claude() {
  const log: string[] = [];
  let opened = 0;
  const open = async () => {
    opened++;
    return {
      request: async (req: any) => { log.push(req.subtype); return req.subtype === "get_session_cost" ? { text: "Total cost: $0.0000\nUsage: 0 input, 0 output, 0 cache read, 0 cache write" } : { content: [{ type: "text", text: "via claude" }] }; },
      waitForServers: async (names?: string[]) => { log.push(`wait:${names?.join(",")}`); return [{ name: calendar.connectorName, status: "connected", tools: [] }]; },
      close: async () => { log.push("close"); },
    };
  };
  return { open, log, opened: () => opened };
}
const session = (p: ReturnType<typeof proxy>, c = claude(), o: { login?: Login | null; needs?: Manifest[] } = {}) =>
  new DirectSession(o.needs ?? [calendar], c.open as never, { login: () => (o.login === undefined ? login : o.login ?? undefined), fetch: p.fetch });

afterEach(() => { delete process.env.PLUGBOARD_DIRECT; delete process.env.CLAUDE_CONFIG_DIR; });

test("a call goes to the connector proxy only, with the login, and never starts Claude Code", async () => {
  const p = proxy(ok()), c = claude(), s = session(p, c);
  const servers = await s.waitForServers([calendar.connectorName]);
  expect(servers).toMatchObject([{ name: calendar.connectorName, status: "connected" }]);
  expect(await s.request<unknown>(CALL)).toEqual(RESULT);
  expect(p.sent).toHaveLength(1);
  expect(p.sent[0]!.url).toBe(`${PROXY_ORIGIN}/v1/mcp/mcpsrv_01cal`);
  expect(p.sent[0]!.headers.get("authorization")).toBe("Bearer secret-token");
  expect(p.sent[0]!.body).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "list_calendars", arguments: {} } });
  await costGuard(s); // nothing but the proxy was reached: zero by construction
  await s.close();
  expect(c.opened()).toBe(0);
});

test("a streamed (SSE) answer is read like a JSON one", async () => {
  expect(await session(proxy(ok(RESULT, true))).request<unknown>(CALL)).toEqual(RESULT);
});

for (const status of [400, 401, 403, 404])
  test(`an HTTP ${status} (refused, the tool never ran) falls back to Claude Code for the rest of the session`, async () => {
    const p = proxy(() => new Response("no", { status })), c = claude(), s = session(p, c);
    expect(await s.request<unknown>(CALL)).toEqual({ content: [{ type: "text", text: "via claude" }] });
    expect(await s.request<unknown>(CALL)).toEqual({ content: [{ type: "text", text: "via claude" }] });
    expect(p.sent).toHaveLength(1);
    expect(c.log).toEqual([`wait:${calendar.connectorName}`, "mcp_call", "mcp_call"]);
    await costGuard(s); // asked of Claude Code once it ran
    expect(c.log.at(-1)).toBe("get_session_cost");
  });

test("a connection that never opened falls back", async () => {
  const p = proxy(() => { throw Object.assign(new TypeError("fetch failed"), { code: "ConnectionRefused" }); }), c = claude();
  expect(await session(p, c).request<unknown>(CALL)).toEqual({ content: [{ type: "text", text: "via claude" }] });
  expect(c.opened()).toBe(1);
});

test("without a usable login or a cached ID, the session is Claude Code's from the start", async () => {
  for (const [l, needs] of [
    [null, [calendar]],
    [{ ...login, expiresAt: Date.now() + 30_000 }, [calendar]], // expiring within a minute: Claude Code renews it
    [{ ...login, scopes: ["user:inference"] }, [calendar]],
    [login, [{ ...calendar, server: undefined }]],
  ] as [Login | null, Manifest[]][]) {
    const p = proxy(ok()), c = claude(), s = session(p, c, { login: l, needs });
    await s.waitForServers([calendar.connectorName]);
    expect(await s.request<unknown>(CALL)).toEqual({ content: [{ type: "text", text: "via claude" }] });
    expect(p.sent).toHaveLength(0);
  }
});

test("after a send, nothing falls back: a timeout, a 5xx and a 429 are reported, Claude Code never starts", async () => {
  const slow = proxy(() => new Promise(() => {}));
  const c = claude();
  const timedOut = await invoke(session(slow, c), { tool: calendar.tools[0], args: {} } as never, 50).catch(e => e);
  expect(timedOut.code).toBe("TIMEOUT");
  const down = await invoke(session(proxy(() => new Response("bad gateway", { status: 502 })), c), { tool: calendar.tools[0], args: {} } as never, 1_000).catch(e => e);
  expect(down.code).toBe("UPSTREAM_ERROR");
  const limited = await invoke(session(proxy(() => new Response("slow down", { status: 429 })), c), { tool: calendar.tools[0], args: {} } as never, 1_000).catch(e => e);
  expect(limited.code).toBe("RATE_LIMITED");
  expect(c.opened()).toBe(0);
});

test("a tool's own error and a JSON-RPC error come back as errors, without a fallback", async () => {
  const c = claude();
  expect(await session(proxy(ok({ isError: true, content: [{ type: "text", text: "calendar not found" }] })), c).request(CALL)).toMatchObject({ isError: true });
  const rpc = proxy(s => Response.json({ jsonrpc: "2.0", id: s.body.id, error: { code: -32602, message: "Unknown tool" } }));
  await expect(session(rpc, c).request(CALL)).rejects.toThrow("Unknown tool");
  expect(c.opened()).toBe(0);
});

test("on by default; PLUGBOARD_DIRECT=0 or a custom CLAUDE_CONFIG_DIR turns it off", () => {
  expect(directEnabled()).toBe(true);
  process.env.PLUGBOARD_DIRECT = "0";
  expect(directEnabled()).toBe(false);
  delete process.env.PLUGBOARD_DIRECT;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/elsewhere";
  expect(directEnabled()).toBe(false);
});

test("connect gives a session that needs connectors the direct path (no login read until it's used); off, it starts Claude Code", async () => {
  const { connect } = await import("../src/claude");
  const { parsePolicy } = await import("../src/policy");
  expect(await connect(parsePolicy("", "policy.toml"), [calendar])).toBeInstanceOf(DirectSession);
  process.env.PLUGBOARD_DIRECT = "0";
  const off = await connect(parsePolicy("claude_path = \"/nonexistent/claude\"", "policy.toml"), [calendar]).catch(e => e);
  expect(off.code).toBe("BRIDGE_BROKEN"); // it tried to start Claude Code
});
