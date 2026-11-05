// The direct session against a fake proxy (fetch) and a fake Claude Code: no network, no keychain.
import { afterEach, describe, expect, test } from "bun:test";
import type { Manifest } from "../src/cache";
import { costGuard } from "../src/claude";
import { DirectSession, PROXY_ORIGIN, resolveTransport, viaOf, type Login } from "../src/direct";
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

afterEach(() => { delete process.env.PLUGBOARD_DIRECT; delete process.env.PLUGBOARD_TRANSPORT; delete process.env.CLAUDE_CONFIG_DIR; });

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

describe("transport", () => {
  const policy = (transport?: string) => ({ transport } as never);
  afterEach(() => { delete process.env.PLUGBOARD_TRANSPORT; });
  test("auto by default; the narrowest setting wins: the call's, the environment's, then the policy's", () => {
    expect(resolveTransport(policy())).toBe("auto");
    expect(resolveTransport(policy("claude-code"))).toBe("claude-code");
    process.env.PLUGBOARD_TRANSPORT = "direct";
    expect(resolveTransport(policy("claude-code"))).toBe("direct");
    expect(resolveTransport(policy("claude-code"), "auto")).toBe("auto");
  });
  test("PLUGBOARD_DIRECT=0, from 0.1.3, still means claude-code", () => {
    process.env.PLUGBOARD_DIRECT = "0";
    expect(resolveTransport(policy())).toBe("claude-code");
  });
  test("a custom CLAUDE_CONFIG_DIR keeps auto on Claude Code: where it keeps the login is unverified", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/elsewhere";
    expect(resolveTransport(policy())).toBe("claude-code");
    expect(resolveTransport(policy("direct"))).toBe("direct");
  });
  test("an unknown value is a usage error naming the values", () => {
    process.env.PLUGBOARD_TRANSPORT = "fast";
    expect(() => resolveTransport(policy())).toThrow(/auto, direct, claude-code/);
  });
  test("direct never starts Claude Code: a refusal, or no login, is UNREACHABLE and recorded as not sent", async () => {
    const c = claude();
    const refused = new DirectSession([calendar], c.open as never, { login: () => login, fetch: proxy(() => new Response("no", { status: 401 })).fetch }, { fallback: false });
    const e1 = await refused.request<unknown>(CALL).catch(e => e) as { code: string; message: string };
    expect(e1.code).toBe("UNREACHABLE");
    expect(e1.message).toContain("401");
    const { wasNotSent } = await import("../src/errors");
    expect(wasNotSent(e1)).toBe(true);
    const nologin = new DirectSession([calendar], c.open as never, { login: () => undefined, fetch: proxy(ok()).fetch }, { fallback: false });
    expect((await nologin.waitForServers().catch(e => e)).code).toBe("UNREACHABLE");
    expect(c.opened()).toBe(0);
  });
});

test("via: a result the proxy served says direct; one Claude Code served says claude-code", async () => {
  const direct = await session(proxy(ok())).request<object>(CALL);
  expect(viaOf(direct)).toBe("direct");
  const fell = await session(proxy(() => new Response("no", { status: 404 }))).request<object>(CALL);
  expect(viaOf(fell)).toBe("claude-code");
});

test("connect gives a session that needs connectors the direct path (no login read until it's used); off, it starts Claude Code", async () => {
  const { connect } = await import("../src/claude");
  const { parsePolicy } = await import("../src/policy");
  expect(await connect(parsePolicy("", "policy.toml"), [calendar])).toBeInstanceOf(DirectSession);
  process.env.PLUGBOARD_DIRECT = "0";
  const off = await connect(parsePolicy("claude_path = \"/nonexistent/claude\"", "policy.toml"), [calendar]).catch(e => e);
  expect(off.code).toBe("UNREACHABLE"); // it tried to start Claude Code
});

// Real fetch against a loopback server: the answer's headers arrive in time, its body doesn't.
async function lateBody(bodyAfterMs: number) {
  const runs = { n: 0 };
  const server = Bun.serve({ port: 0, fetch: () => {
    runs.n++;
    const stream = new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(": open\n\n")); await Bun.sleep(bodyAfterMs); c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: RESULT })}\n\n`)); c.close(); } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } });
  const fetchVia = ((_url: string, init: RequestInit) => fetch(`http://127.0.0.1:${server.port}/`, init)) as unknown as typeof fetch;
  return { fetchVia, runs, stop: () => server.stop(true) };
}

test("an answer cut off by the deadline after its headers is a timeout: the tool may have run, nothing falls back", async () => {
  const late = await lateBody(400);
  try {
    const c = claude();
    const s = new DirectSession([calendar], c.open as never, { login: () => login, fetch: late.fetchVia });
    const error = await invoke(s, { tool: calendar.tools[0], args: {} } as never, 150).catch(e => e);
    expect(error.code).toBe("TIMEOUT");
    expect(c.opened()).toBe(0);
  } finally { late.stop(); }
});

test("a connection lost after the request left is a timeout, not an error that would allow a resend", async () => {
  const p = proxy(() => { throw Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" }); }), c = claude();
  const error = await invoke(session(p, c), { tool: calendar.tools[0], args: {} } as never, 1_000).catch(e => e);
  expect(error.code).toBe("TIMEOUT");
  expect(c.opened()).toBe(0);
});

test("a fetch error never carries the login into the message", async () => {
  const p = proxy(() => { throw new TypeError("Header 'Authorization' has invalid value: 'Bearer secret-token'"); });
  const error = await invoke(session(p), { tool: calendar.tools[0], args: {} } as never, 1_000).catch(e => e);
  expect(String(error.message)).not.toContain("secret-token");
});

test("after a fallback, a connector Claude Code lists as not connected is AUTH_REQUIRED, as without the direct path", async () => {
  const p = proxy(() => new Response("no", { status: 401 }));
  const open = async () => ({
    request: async () => { throw new Error("must not be called"); },
    waitForServers: async () => [{ name: calendar.connectorName, status: "needs-auth", tools: [] }],
    close: async () => {},
  });
  const error = await invoke(new DirectSession([calendar], open as never, { login: () => login, fetch: p.fetch }), { tool: calendar.tools[0], args: {} } as never, 1_000).catch(e => e);
  expect(error.code).toBe("AUTH_REQUIRED");
  expect(error.message).toContain("needs-auth");
});

test("a session says why it isn't direct", async () => {
  const c = claude();
  const none = session(proxy(ok()), c, { login: null });
  await none.waitForServers();
  expect(none.notDirect).toBe("no claude.ai login found");
  const refused = session(proxy(() => new Response("no", { status: 404 })), c);
  await refused.request<unknown>(CALL);
  expect(refused.notDirect).toBe("the connector proxy refused the call (404)");
  const direct = session(proxy(ok()), c);
  await direct.request<unknown>(CALL);
  expect(direct.notDirect).toBeUndefined();
});

describe("the shared session", () => {
  const drive: Manifest = {
    id: "google-drive", connectorName: "claude.ai Google Drive", capturedAt: "2026-11-05T00:00:00Z",
    server: { type: "claudeai-proxy", url: "https://drivemcp.googleapis.com/mcp/v1", id: "mcpsrv_01drive" },
    tools: [{ name: "list_recent_files", sourceName: "mcp__claude_ai_Google_Drive__list_recent_files", inputSchema: { type: "object" } }],
  };
  const DRIVE_CALL = { subtype: "mcp_call", tool: drive.tools[0]!.sourceName, arguments: {} };
  const logins = (...list: Login[]) => { let i = 0; return () => list[Math.min(i++, list.length - 1)]; };
  const VIA_CLAUDE = { content: [{ type: "text", text: "via claude" }] };

  test("takes connectors on as they are first called", async () => {
    const p = proxy(ok()), c = claude();
    const s = new DirectSession([], c.open as never, { login: () => login, fetch: p.fetch });
    s.use([calendar]);
    expect(await s.request<unknown>(CALL)).toEqual(RESULT);
    s.use([drive, calendar]); // a connector already taken on is no change
    expect(await s.request<unknown>(DRIVE_CALL)).toEqual(RESULT);
    expect(p.sent.map(x => x.url)).toEqual([`${PROXY_ORIGIN}/v1/mcp/mcpsrv_01cal`, `${PROXY_ORIGIN}/v1/mcp/mcpsrv_01drive`]);
    expect(c.opened()).toBe(0);
  });

  test("a connector the proxy refuses goes through Claude Code; one taken on later still goes direct", async () => {
    const p = proxy(s => (s.url.endsWith("mcpsrv_01cal") ? new Response("no", { status: 404 }) : ok()(s))), c = claude();
    const s = new DirectSession([calendar], c.open as never, { login: () => login, fetch: p.fetch });
    expect(await s.request<unknown>(CALL)).toEqual(VIA_CLAUDE);
    s.use([drive]);
    expect(await s.request<unknown>(DRIVE_CALL)).toEqual(RESULT);
    expect(await s.request<unknown>(CALL)).toEqual(VIA_CLAUDE); // the refused one stays with Claude Code, not asked again
    expect(p.sent).toHaveLength(2);
  });

  test("once Claude Code runs, a connector taken on later waits for its own discovery there", async () => {
    const p = proxy(() => new Response("no", { status: 403 })), c = claude();
    const s = new DirectSession([calendar], c.open as never, { login: () => login, fetch: p.fetch });
    await s.request<unknown>(CALL);
    s.use([drive]);
    await s.request<unknown>(DRIVE_CALL).catch(() => undefined); // the fake lists only calendar: refused as not connected
    expect(c.log).toContain(`wait:${drive.connectorName}`);
  });

  test("a login close to expiring is read again before a call, so a renewed one is used", async () => {
    const soon = { ...login, accessToken: "old-token", expiresAt: Date.now() + 4 * 60_000 }; // usable, but within five minutes
    const p = proxy(ok()), c = claude();
    const s = new DirectSession([calendar], c.open as never, { login: logins(soon, login), fetch: p.fetch });
    await s.request<unknown>(CALL);
    await s.request<unknown>(CALL);
    expect(p.sent.map(x => x.headers.get("authorization"))).toEqual(["Bearer old-token", "Bearer secret-token"]);
  });

  test("a login too close to expiring sends that call through Claude Code, and the next goes direct once it's renewed", async () => {
    const expiring = { ...login, expiresAt: Date.now() + 30_000 };
    const p = proxy(ok()), c = claude();
    const s = new DirectSession([calendar], c.open as never, { login: logins(expiring, login), fetch: p.fetch });
    expect(await s.request<unknown>(CALL)).toEqual(VIA_CLAUDE);
    expect(await s.request<unknown>(CALL)).toEqual(RESULT);
    expect(p.sent).toHaveLength(1);
  });

  test("a login the proxy refused (401) isn't sent again; a renewed one is", async () => {
    const refusedToken = { ...login, accessToken: "refused-token" };
    const p = proxy(x => (x.headers.get("authorization") === "Bearer refused-token" ? new Response("no", { status: 401 }) : ok()(x))), c = claude();
    const s = new DirectSession([calendar], c.open as never, { login: logins(refusedToken, refusedToken, login), fetch: p.fetch });
    expect(await s.request<unknown>(CALL)).toEqual(VIA_CLAUDE);
    expect(await s.request<unknown>(CALL)).toEqual(VIA_CLAUDE); // the same login read again: not sent again
    expect(await s.request<unknown>(CALL)).toEqual(RESULT);
    expect(p.sent.map(x => x.headers.get("authorization"))).toEqual(["Bearer refused-token", "Bearer secret-token"]);
  });

  test("Claude Code, once idle, is closed, and started again when a call needs it", async () => {
    const p = proxy(() => new Response("no", { status: 404 })), c = claude();
    const s = new DirectSession([calendar], c.open as never, { login: () => login, fetch: p.fetch }, { idleMs: 50 });
    await s.request<unknown>(CALL);
    await Bun.sleep(120);
    expect(c.log).toContain("close");
    expect(await s.request<unknown>(CALL)).toEqual(VIA_CLAUDE);
    expect(c.opened()).toBe(2);
    await s.close();
  });
});
