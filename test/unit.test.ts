import { describe, expect, test } from "bun:test";
import { AxiError } from "axi-sdk-js";
import { keyState } from "../src/audit";
import { mergeCapture, shortName, findTool, type Manifest } from "../src/cache";
import { applyTransforms, canonical, payloadHash, refOf, timeParams } from "../src/call";
import { asAxiError, classify as classifyError } from "../src/errors";
import { cacheDir, collapseHome } from "../src/platform";
import { DiscoveryTimeoutError } from "../src/bridge/client";
import { mergeArgs, parseFlags, toolHelp } from "../src/flags";
import { fileOf, markdownOf, render, shape, unwrap } from "../src/output";
import { axiSummary } from "../src/batch";
import { encode } from "@toon-format/toon";
import { classify, decide, parsePolicy } from "../src/policy";
import { formatTime, parseTime } from "../src/time";
import { setupCommand } from "../src/cli";
import { probe } from "../src/doctor";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schema = {
  type: "object",
  required: ["channel_id"],
  properties: {
    channel_id: { type: "string" },
    limit: { type: "integer" },
    ratio: { type: "number" },
    include_bots: { type: "boolean" },
    sort: { type: "string", enum: ["score", "timestamp"] },
    keywords: { type: "array", items: { type: "string" } },
    fields: { type: "array" },
    telemetry: { type: "object", properties: { intent: { type: "string" }, depth: { type: "integer" } } },
    payload: { anyOf: [{ type: "object" }, { type: "string" }] },
    calendarId: { type: "string" },
    mode: { type: "string" },
  },
};
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AxiError).code; } return "none"; };

describe("schema → flags", () => {
  test("scalars, enums, booleans, negation, repeatables, camelCase and inline values", () => {
    const p = parseFlags(["--channel-id", "C1", "--limit=5", "--ratio", "0.5", "--include-bots", "--sort", "timestamp",
      "--keywords", "a", "--keywords", "b", "--calendar-id", "primary", "--mode", "x"], schema);
    expect(p.args).toEqual({ channel_id: "C1", limit: 5, ratio: 0.5, include_bots: true, sort: "timestamp", keywords: ["a", "b"], calendarId: "primary", mode: "x" });
    expect(parseFlags(["--no-include-bots"], schema).args).toEqual({ include_bots: false });
    expect(parseFlags(["--channel_id", "C1", "--keywords", '["x","y"]'], schema).args).toEqual({ channel_id: "C1", keywords: ["x", "y"] });
  });
  test("bad values are VALIDATION_ERROR", () => {
    expect(code(() => parseFlags(["--limit", "1.5"], schema))).toBe("VALIDATION_ERROR");
    expect(code(() => parseFlags(["--sort", "best"], schema))).toBe("VALIDATION_ERROR");
    expect(code(() => parseFlags(["--nope", "1"], schema))).toBe("VALIDATION_ERROR");
    expect(code(() => parseFlags(["positional"], schema))).toBe("VALIDATION_ERROR");
    expect(code(() => parseFlags(["--telemetry", "not json"], schema))).toBe("VALIDATION_ERROR");
    expect(code(() => parseFlags(["--channel-id"], schema))).toBe("VALIDATION_ERROR");
  });
  test("objects: JSON, dot-flags typed from the nested schema; anyOf falls back to a string", () => {
    const p = parseFlags(["--telemetry", '{"intent":"a"}', "--telemetry.depth", "3", "--payload", "plain"], schema);
    expect(mergeArgs(p)).toEqual({ telemetry: { intent: "a", depth: 3 }, payload: "plain" });
    expect(mergeArgs(parseFlags(["--payload", '{"k":1}'], schema))).toEqual({ payload: { k: 1 } });
  });
  test("a parameter named like a global flag is only reachable through --json", () => {
    const clash = { type: "object", properties: { out: { type: "string" }, channel_id: { type: "string" } } };
    const p = parseFlags(["--out", "json", "--json", '{"out":"file.txt","channel_id":"C0"}', "--channel-id", "C9"], clash);
    expect(p.globals.out).toBe("json");
    expect(mergeArgs(p)).toEqual({ out: "file.txt", channel_id: "C9" });
    expect(toolHelp({ bin: "x", connector: "c", short: "t", schema: clash, cls: "read", reason: "r", timeParams: [], full: false })).toContain("only via --json (names clash with global flags): out");
    expect(parseFlags(["--fields", "[1]"], schema).args).toEqual({ fields: [1] }); // `fields` is not ours: --select is
  });
  test("merge order: --arg-file < --json < flags < dot-flags", () => {
    const file = `${import.meta.dir}/../node_modules/.args-test.json`;
    Bun.write(file, JSON.stringify({ channel_id: "file", limit: 1, telemetry: { intent: "file" } }));
    const p = parseFlags(["--arg-file", file, "--json", '{"limit":2,"telemetry":{"intent":"json"}}', "--limit", "3", "--telemetry.intent", "dot"], schema);
    expect(mergeArgs(p)).toEqual({ channel_id: "file", limit: 3, telemetry: { intent: "dot" } });
  });
  test("global flags parse and never leak into args", () => {
    const p = parseFlags(["--as", "gather", "--write", "--plan", "--select", "a,b", "--where", "x > 1", "--out", "json", "--channel-id", "C"], schema);
    expect(p.globals).toEqual({ as: "gather", write: true, plan: true, select: "a,b", where: "x > 1", out: "json" });
    expect(p.args).toEqual({ channel_id: "C" });
  });
});

const policy = parsePolicy(`
[overrides]
read = ["slack:unannotated_read"]
write = ["slack:lying_read"]
[profiles.gather]
mode = "read"
allow = ["slack:*", "cal:*"]
deny = ["slack:*_draft*"]
[profiles.executor]
mode = "write"
allow = ["slack:send", "slack:*"]
[profiles.destroyer]
mode = "write"
allow = ["slack:delete"]
allow_destructive = true
`, "test.toml");
const t = (name: string, annotations?: Record<string, boolean>) => ({ name, annotations });

describe("policy", () => {
  test("classify fails closed: only readOnlyHint (and not destructive) is read; overrides win", () => {
    expect(classify(policy, "slack", t("search", { readOnlyHint: true }))).toBe("read");
    expect(classify(policy, "slack", t("send"))).toBe("write");
    expect(classify(policy, "slack", t("x", { readOnlyHint: true, destructiveHint: true }))).toBe("write");
    expect(classify(policy, "slack", t("unannotated_read"))).toBe("read");
    expect(classify(policy, "slack", t("lying_read", { readOnlyHint: true }))).toBe("write");
  });
  test("a read glob never grants a write tool, in any profile", () => {
    expect(code(() => decide(policy, "gather", "slack", t("send"), false))).toBe("POLICY_DENIED");
    expect(code(() => decide(policy, "executor", "slack", t("post"), true))).toBe("POLICY_DENIED"); // slack:* doesn't name it
    expect(() => decide(policy, "executor", "slack", t("send"), true)).not.toThrow();
    expect(() => decide(policy, "executor", "slack", t("search", { readOnlyHint: true }), false)).not.toThrow();
  });
  test("deny beats allow; --write needs a write profile; writes need --write; destructive needs opt-in", () => {
    expect(code(() => decide(policy, "gather", "slack", t("save_draft", { readOnlyHint: true }), false))).toBe("POLICY_DENIED");
    expect(code(() => decide(policy, "gather", "slack", t("search", { readOnlyHint: true }), true))).toBe("POLICY_DENIED");
    expect(code(() => decide(policy, "executor", "slack", t("send"), false))).toBe("POLICY_DENIED");
    expect(code(() => decide(policy, "executor", "slack", t("send", { destructiveHint: true }), true))).toBe("POLICY_DENIED");
    expect(() => decide(policy, "destroyer", "slack", t("delete", { destructiveHint: true }), true)).not.toThrow();
    expect(code(() => decide(policy, "nobody", "slack", t("search", { readOnlyHint: true }), false))).toBe("POLICY_DENIED");
  });
  test("aliases resolve in patterns; the default profile reads everything; bad files are validation errors", () => {
    expect(() => decide(policy, "gather", "google-calendar", t("list_events", { readOnlyHint: true }), false)).not.toThrow();
    expect(() => decide(policy, "default", "datadog", t("anything", { readOnlyHint: true }), false)).not.toThrow();
    expect(code(() => decide(policy, "default", "datadog", t("anything"), true))).toBe("POLICY_DENIED");
    expect(code(() => parsePolicy("[profiles.x]\nmode = 'admin'", "p"))).toBe("VALIDATION_ERROR");
    expect(code(() => parsePolicy("[profiles.x]\nallow = ['nocolon']", "p"))).toBe("VALIDATION_ERROR");
    expect(code(() => parsePolicy("[transforms]\n'a:b.c' = 'weekday'", "p"))).toBe("VALIDATION_ERROR");
  });
});

describe("doctor probe", () => {
  const tools = [{ name: "a" }, { name: "b" }];
  test("moves to the next tool only when the connector rejects the call", async () => {
    const tried: string[] = [];
    const result = await probe(tools, async t => { tried.push(t.name); if (t.name === "a") throw new AxiError("bad args", "UPSTREAM_ERROR", []); });
    expect(tried).toEqual(["a", "b"]);
    expect(result.tool?.name).toBe("b");
  });
  test("stops at a timeout or auth failure: the connector is down", async () => {
    for (const code of ["TIMEOUT", "AUTH_REQUIRED", "RATE_LIMITED"]) {
      const tried: string[] = [];
      const result = await probe(tools, async t => { tried.push(t.name); throw new AxiError("down", code, []); });
      expect(tried).toEqual(["a"]);
      expect(result.error).toContain("a: down");
    }
  });
});

describe("transforms", () => {
  const evil = `[transforms]\n"cal:list_events.updatedMin" = "unix"\n"slack:slack_search_public.after" = "date"\n[profiles.evil]\nmode = "write"\nallow = ["slack:slack_send_message"]\nallow_in_agent = true\n[aliases]\nx = "y"`;
  test("built-in rules apply with no files at all", () => {
    expect(parsePolicy("", "p").transforms["google-calendar:list_events.startTime"]).toBe("rfc3339");
    expect(parsePolicy("", "p").aliases.cal).toBe("google-calendar");
  });
  test("transforms.toml adds transforms and nothing else; policy.toml wins over it", () => {
    const p = parsePolicy(`[transforms]\n"slack:slack_search_public.after" = "unix"`, "policy.toml", { text: evil, path: "transforms.toml" });
    expect(p.transforms["google-calendar:list_events.updatedMin"]).toBe("unix"); // alias resolved
    expect(p.transforms["slack:slack_search_public.after"]).toBe("unix"); // policy.toml wins
    expect(p.transforms["google-calendar:list_events.startTime"]).toBe("rfc3339"); // built-in kept
    expect(p.profiles.evil).toBeUndefined();
    expect(p.aliases.x).toBeUndefined();
    expect(code(() => parsePolicy("", "p", { text: "[transforms]\n'a:b.c' = 'weekday'", path: "t" }))).toBe("VALIDATION_ERROR");
  });
  test("a bad transforms.toml stops the command with an error naming that file, not the policy", () => {
    const errorOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e as AxiError; } throw new Error("no error"); };
    for (const text of ["[transforms]\n'a:b.c' = 'weekday'", "[transforms]\n'a:b.c' = \n"]) {
      const e = errorOf(() => parsePolicy("", "/c/policy.toml", { text, path: "/c/transforms.toml" }));
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.message.startsWith("/c/transforms.toml: ")).toBe(true);
      expect(e.message).not.toContain("policy");
      expect(e.suggestions.join(" ")).toContain("Fix or remove the bad line in /c/transforms.toml");
    }
    const policyError = errorOf(() => parsePolicy("[profiles.x]\nmode = 'admin'", "/c/policy.toml"));
    expect(policyError.message.startsWith("/c/policy.toml: ")).toBe(true);
    expect(policyError.suggestions).toEqual(["Edit /c/policy.toml"]);
    // transforms must be a table, in either file
    expect(errorOf(() => parsePolicy("", "/c/policy.toml", { text: "transforms = 'unix'", path: "/c/transforms.toml" })).message).toBe("/c/transforms.toml: transforms must be a table of \"connector:tool.param\" = \"format\"");
    expect(errorOf(() => parsePolicy("transforms = 5", "/c/policy.toml")).message.startsWith("/c/policy.toml: transforms must be a table")).toBe(true);
  });
  test("a key may use the names the CLI shows: short tool name and flag name", () => {
    const tool = { name: "slack_search_public", sourceName: "s", annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { afterTs: { type: "string" } } } };
    const p = parsePolicy("", "p", { text: `[transforms]\n"slack:search-public.after-ts" = "date"`, path: "t" });
    expect(timeParams(p, "slack", tool)).toEqual(["afterTs"]);
    expect(applyTransforms(p, "slack", tool, { afterTs: "2026-11-03" }).afterTs).toBe("2026-11-03");
  });
  test("a value already in the target format passes through; relative input converts", () => {
    const tool = { name: "list", sourceName: "s", annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { at: { type: "string" }, day: { type: "string" }, ts: { type: "string" }, ms: { type: "string" } } } };
    const p = parsePolicy("", "p", { text: `[transforms]\n"c:list.at" = "rfc3339"\n"c:list.day" = "date"\n"c:list.ts" = "unix"\n"c:list.ms" = "unix-ms"`, path: "t" });
    for (const at of ["2026-11-03T10:00:00.500Z", "2026-11-03T10:00:00", "2026-11-03T10:00:00+05:30"])
      expect(applyTransforms(p, "c", tool, { at }).at).toBe(at);
    expect(applyTransforms(p, "c", tool, { day: "2026-11-03", ts: "1793704741.123456", ms: "1793704741000" }))
      .toEqual({ day: "2026-11-03", ts: "1793704741.123456", ms: "1793704741000" });
    expect(applyTransforms(p, "c", tool, { at: "-1d" }).at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(applyTransforms(p, "c", tool, { ts: "2026-11-03" }).ts).toMatch(/^\d{10}$/);
  });
  test("a write tool is never converted, even with a rule, and its help claims nothing", () => {
    const tool = { name: "send", sourceName: "s", inputSchema: { type: "object", properties: { message: { type: "string" }, at: { type: "string", format: "date-time" } } } };
    const p = parsePolicy("", "p", { text: `[transforms]\n"c:send.message" = "unix"`, path: "t" });
    expect(applyTransforms(p, "c", tool, { message: "-1d", at: "today" })).toEqual({ message: "-1d", at: "today" });
    expect(timeParams(p, "c", tool)).toEqual([]);
  });
  test("a read parameter whose schema declares format date-time or date converts without a rule", () => {
    const tool = (annotations?: Record<string, boolean>) => ({ name: "list", sourceName: "s", annotations,
      inputSchema: { type: "object", properties: { at: { type: "string", format: "date-time" }, day: { type: "string", format: "date" }, q: { type: "string" } } } });
    const p = parsePolicy("", "p");
    expect(timeParams(p, "c", tool({ readOnlyHint: true }))).toEqual(["at", "day"]);
    const out = applyTransforms(p, "c", tool({ readOnlyHint: true }), { at: "2026-11-03", day: "2026-11-03", q: "today" });
    expect(out.at).toMatch(/^2026-11-03T00:00:00[+-]\d{2}:\d{2}$/);
    expect(out).toMatchObject({ day: "2026-11-03", q: "today" });
  });
});

describe("hash and audit", () => {
  test("canonical hash ignores key order and changes on any byte", () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: "é" } })).toBe('{"a":{"c":"é","d":[1,{"x":1,"y":2}]},"b":1}');
    expect(payloadHash("slack", "send", { a: 1, b: 2 })).toBe(payloadHash("slack", "send", { b: 2, a: 1 }));
    expect(payloadHash("slack", "send", { a: 1 })).not.toBe(payloadHash("slack", "send", { a: 2 }));
    expect(payloadHash("slack", "send", { a: 1 })).not.toBe(payloadHash("slack", "post", { a: 1 }));
  });
  test("key state: attempt without outcome is unknown; resolve settles it", () => {
    const e = (key: string, status: string) => ({ ts: "", key, status }) as never;
    expect(keyState("k", []).state).toBe("none");
    expect(keyState("k", [e("k", "attempt")]).state).toBe("unknown");
    expect(keyState("k", [e("k", "attempt"), e("k", "ok")]).state).toBe("ok");
    expect(keyState("k", [e("k", "attempt"), e("k", "error")]).state).toBe("error");
    expect(keyState("k", [e("k", "attempt"), e("k", "unknown"), e("k", "resolved-not-sent")]).state).toBe("error");
    expect(keyState("k", [e("k", "attempt"), e("k", "resolved-sent")]).state).toBe("ok");
    expect(keyState("k", [e("j", "attempt")]).state).toBe("none");
  });
  test("refOf finds a sent reference", () => {
    expect(refOf({ ok: true, ts: "1.2" })).toBe("1.2");
    expect(refOf({ message: { id: "m1" } })).toBe("m1");
    expect(refOf({ ok: true })).toBeUndefined();
  });
});

describe("output", () => {
  test("unwrap: structuredContent, a JSON string, Slack's text block holding JSON, plain text", () => {
    expect(unwrap({ content: '{"calendars":[]}', structuredContent: { calendars: [1] } })).toEqual({ calendars: [1] });
    expect(unwrap({ content: '{"labels":[]}' })).toEqual({ labels: [] });
    expect(unwrap({ content: [{ type: "text", text: '{"results":"# md"}' }] })).toEqual({ results: "# md" });
    expect(unwrap({ content: [{ type: "text", text: "plain" }] })).toEqual({ text: "plain" });
    expect(unwrap({ content: [{ type: "text", text: "[1]" }, { type: "text", text: "[2]" }] })).toEqual([[1], [2]]);
  });
  test("--select / --where apply to the only list; several lists need --items", () => {
    const v = { next: "c", items: [{ a: 1, b: { c: 2 } }, { a: 3, b: { c: 4 } }] };
    expect(shape(v, { select: ["b.c"], where: "a > 1" })).toEqual({ next: "c", items: [{ b: { c: 4 } }] });
    expect(shape([{ a: 1 }, { a: 2 }], { where: "a == 2" })).toEqual([{ a: 2 }]);
    expect(code(() => shape({ x: [], y: [] }, { select: ["a"] }))).toBe("VALIDATION_ERROR");
    expect(shape({ x: [{ a: 1 }], y: [] }, { select: ["a"], items: "x" })).toEqual({ x: [{ a: 1 }], y: [] });
    expect(shape({ a: 1, b: 2 }, { select: ["a"] })).toEqual({ a: 1 });
    expect(code(() => shape({ a: 1 }, { where: "a == 1" }))).toBe("VALIDATION_ERROR");
  });
  test("md prints Slack's string fields; toon cuts long strings unless --full; json never does", () => {
    expect(markdownOf({ results: "# r", pagination_info: "next" })).toBe("# r\n\nnext");
    const long = "x".repeat(2000);
    const state = process.env.PLUGBOARD_STATE;
    process.env.PLUGBOARD_STATE = mkdtempSync(join(tmpdir(), "plugboard-render-")); // the cut result is written there
    try {
      const out = JSON.stringify(render({ raw: {}, value: { long }, format: "toon", full: false }));
      expect(out).toContain("cut at 1500");
      expect(readFileSync(/full result: ([^ ]+)/.exec(out)![1]!, "utf8")).toContain(long);
    } finally {
      rmSync(process.env.PLUGBOARD_STATE, { recursive: true, force: true });
      if (state === undefined) delete process.env.PLUGBOARD_STATE; else process.env.PLUGBOARD_STATE = state;
    }
    expect(render({ raw: {}, value: { long }, format: "json", full: false })).toBe(JSON.stringify({ long }));
    expect(render({ raw: { content: "r" }, value: {}, format: "raw", full: false })).toBe('{"content":"r"}');
  });
});

describe("errors, time, cache", () => {
  test("a blocked sandbox reads as what it is, not a broken bridge or an unknown error", () => {
    const none = asAxiError(new DiscoveryTimeoutError([]));
    expect(none.code).toBe("BRIDGE_BROKEN");
    expect(none.message).toContain("listed no connectors");
    expect(none.suggestions.join(" ")).toContain("sandbox");
    const pending = asAxiError(new DiscoveryTimeoutError([{ name: "claude.ai Slack", status: "pending", tools: [] }]));
    expect(pending.message).toContain("claude.ai Slack");
    const perm = asAxiError(Object.assign(new Error("EPERM: operation not permitted, open '/x/doctor.json'"), { code: "EPERM" }));
    expect(perm.suggestions.join(" ")).toContain("sandbox");
    expect(asAxiError(new Error("boom")).code).toBe("UNKNOWN");
    expect(asAxiError(new Error("boom"), "UPSTREAM_ERROR").code).toBe("UPSTREAM_ERROR");
    expect(asAxiError(new Error("Claude Code closed stdout")).code).toBe("BRIDGE_BROKEN"); // the classify table still applies
    // A local file error is never read as the connector table: its path or wording can look like an auth or rate limit
    const sys = (message: string, code: string) => Object.assign(new Error(message), { code, syscall: "open" });
    expect(asAxiError(sys("EDQUOT: disk quota exceeded, write", "EDQUOT")).code).toBe("UNKNOWN");
    expect(asAxiError(sys("ENOENT: no such file or directory, open '/srv/403/policy.toml'", "ENOENT")).code).toBe("UNKNOWN");
    const upstream = new AxiError("Slack: permission denied for channel", "UPSTREAM_ERROR");
    expect(asAxiError(upstream)).toBe(upstream); // a connector's own text never gets the sandbox hint
    expect(perm.suggestions.join(" ")).toContain("harness-guides.md#sandboxes"); // a link that works without the repo
    expect(perm.suggestions.join(" ")).toContain(collapseHome(cacheDir())); // refresh and a first call write the cache
  });
  test("error classification table", () => {
    expect(classifyError("invalid_auth")).toBe("AUTH_REQUIRED");
    expect(classifyError("Connector needs authentication")).toBe("AUTH_REQUIRED");
    expect(classifyError("HTTP 429 Too Many Requests")).toBe("RATE_LIMITED");
    expect(classifyError("ratelimited, retry after 3")).toBe("RATE_LIMITED");
    expect(classifyError("Timed out waiting for mcp_call")).toBe("TIMEOUT");
    expect(classifyError("Claude Code closed stdout")).toBe("BRIDGE_BROKEN");
    expect(classifyError("'id' required")).toBe("UPSTREAM_ERROR");
  });
  test("time parsing and formats", () => {
    const now = new Date(2026, 10, 3, 12, 0, 0);
    expect(parseTime("-2d", now)!.getTime()).toBe(now.getTime() - 2 * 86_400_000);
    expect(parseTime("today", now)!.getHours()).toBe(0);
    expect(parseTime("2026-11-05", now)!.getDate()).toBe(5);
    expect(parseTime("1762156800", now)!.getTime()).toBe(1762156800000);
    expect(parseTime("monday 9am", now)!.getDay()).toBe(1);
    expect(parseTime("gibberish zzz", now)).toBeUndefined();
    expect(formatTime(new Date(1762156800000), "unix")).toBe(1762156800);
    expect(String(formatTime(new Date(2026, 10, 3, 9, 30), "rfc3339"))).toMatch(/^2026-11-03T09:30:00[+-]\d{2}:\d{2}$/);
    expect(formatTime(new Date(2026, 10, 3), "date")).toBe("2026-11-03");
  });
  test("refresh merges per connector: auth flaps keep the old manifest; hidden tools are recorded", () => {
    const servers = [
      { name: "claude.ai Slack", status: "connected", tools: [{ name: "slack_search_public", annotations: { readOnly: true } }, { name: "_dd_hidden" }] },
      { name: "claude.ai Gmail", status: "needs-auth", tools: [] },
    ];
    const schemas = [{ name: "mcp__claude_ai_Slack__slack_search_public", inputSchema: { type: "object" } }];
    const prev = { format: 1 as const, testedVersions: [], connectors: { gmail: { name: "claude.ai Gmail", status: "connected", capturedAt: "t0", tools: 30, read: 6, write: 24 } } };
    const { index, manifests, result } = mergeCapture(prev, servers, schemas, undefined, "t1");
    expect(result.updated).toEqual(["slack"]);
    expect(manifests[0]).toMatchObject({ id: "slack", hidden: ["_dd_hidden"], tools: [{ name: "slack_search_public", annotations: { readOnlyHint: true } }] });
    expect(index.connectors.gmail).toMatchObject({ status: "needs-auth", tools: 30, staleSince: "t1" });
  });
  test("short names", () => {
    expect(shortName("slack", "slack_search_public")).toBe("search-public");
    expect(shortName("google-calendar", "list_events")).toBe("list-events");
    expect(shortName("datadog", "search_datadog_logs")).toBe("search-datadog-logs");
    const m = { id: "slack", tools: [{ name: "slack_read_thread" }] } as Manifest;
    expect(findTool(m, "read-thread")?.name).toBe("slack_read_thread");
    expect(findTool(m, "slack_read_thread")?.name).toBe("slack_read_thread");
    expect(findTool(m, "slack-read-thread")?.name).toBe("slack_read_thread");
  });
});

test("setup hooks installs and removes a project-scope session-start hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugboard-hooks-"));
  try {
    const installed = setupCommand(["hooks", "--project"], { homeDir: dir, projectDir: dir });
    expect(installed.claude).toBe(true);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toMatch(/"command": "[^"]*plugboard --axi"/);
    expect(setupCommand(["hooks", "--project", "--remove"], { homeDir: dir, projectDir: dir }).claude).toBe(false);
    expect(code(() => setupCommand(["nope"], { homeDir: dir, projectDir: dir }))).toBe("VALIDATION_ERROR");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("plain text renderer: key lines, aligned tables, hints last", () => {
  const { plainText } = require("../src/output");
  expect(plainText({ profile: "gather", allow: ["a:*", "b:c"], tools: [{ name: "x", class: "read" }, { name: "longer", class: "write" }], help: ["do this"] }))
    .toBe("profile: gather\nallow: a:*, b:c\ntools:\n  NAME    CLASS\n  x       read\n  longer  write\nhint: do this");
  expect(plainText({ empty: [], nested: { a: 1 } })).toBe("empty: -\nnested:\n  a: 1");
});

describe("full results on disk", () => {
  const withState = <T>(fn: (state: string) => T): T => {
    const saved = process.env.PLUGBOARD_STATE;
    const state = mkdtempSync(join(tmpdir(), "plugboard-results-"));
    process.env.PLUGBOARD_STATE = state;
    try { return fn(state); } finally {
      rmSync(state, { recursive: true, force: true });
      if (saved === undefined) delete process.env.PLUGBOARD_STATE; else process.env.PLUGBOARD_STATE = saved;
    }
  };
  const ok = (id: unknown, result: unknown) => ({ id, ok: true, ms: 1, result });

  test("fileOf keeps every key: text stays text only when nothing else would be lost", () => {
    expect(fileOf("a\nb")).toEqual({ ext: "md", text: "a\nb" });
    expect(fileOf({ text: "a\nb" })).toEqual({ ext: "md", text: "a\nb" });
    expect(fileOf({ results: "# r\nx", pagination_info: "next" })).toEqual({ ext: "md", text: "pagination_info: next\n\n# r\nx" });
    const mail = fileOf({ id: "m1", from: "bob@x", subject: "hi", body: "line1\nline2" });
    for (const k of ["id: m1", "from: bob@x", "subject: hi", "line1\nline2"]) expect(mail.text).toContain(k);
    expect(fileOf({ id: "m1", from: "bob@x" }).ext).toBe("toon");
  });

  test("every result gets its own file, whatever the ids", () => withState(() => {
    const ids = ["A", "a", "x", "a-b-3", "a-b", "a b", "__proto__", "con", "lpt1.log", "../up", "a-2.toon", "a"];
    const s = axiSummary(ids.map((id, i) => ok(id, { v: i })), "all");
    const files = s.results.map(r => r.file as string);
    expect(new Set(files.map(f => f.toLowerCase())).size).toBe(ids.length);
    expect(readdirSync(s.run)).toHaveLength(ids.length);
    files.forEach((f, i) => expect(readFileSync(join(s.run, f), "utf8")).toContain(`v: ${i}`));
    expect(files).not.toContain("con.toon");
    expect(files).not.toContain("lpt1.log.toon"); // reserved whatever the extension
    expect(Object.keys(s.inline!)).toHaveLength(ids.length); // __proto__ included
  }));

  test("the printed output stays within the budget, manifest included", () => withState(() => {
    const quoted = { text: 'say "x"\n'.repeat(450) }; // ~3.6K chars on disk, more once escaped inline
    const s = axiSummary(Array.from({ length: 8 }, (_, i) => ok(`r${i}`, quoted)));
    expect(encode(s).length).toBeLessThanOrEqual(15_000 + 2_000); // the budget, plus help lines
  }));

  test("a cost-guard failure is its own field, not a result row", () => withState(() => {
    const s = axiSummary([ok("a", { v: 1 }), { id: null, ok: false, error: { code: "COST_GUARD", message: "spent $0.01", retryable: false } }] as never);
    expect(s.results).toHaveLength(1);
    expect(s.error).toEqual({ code: "COST_GUARD", message: "spent $0.01" });
  }));

  test("when results can't be written, nothing is lost: batch inlines them and a cut call keeps the --full hint", () => {
    const saved = process.env.PLUGBOARD_STATE;
    const file = join(mkdtempSync(join(tmpdir(), "plugboard-nodir-")), "a-file");
    writeFileSync(file, "");
    process.env.PLUGBOARD_STATE = file; // a file, so no folder can be made under it
    try {
      const s = axiSummary([ok("big", { t: "z".repeat(40_000) })]);
      expect(s.results[0]!.file).toBeNull();
      expect(JSON.stringify(s.inline)).toContain("z".repeat(40_000));
      expect(s.help.join(" ")).toContain("not written");
      const out = JSON.stringify(render({ raw: {}, value: { long: "x".repeat(2000) }, format: "toon", full: false }));
      expect(out).toContain("add --full");
    } finally {
      if (saved === undefined) delete process.env.PLUGBOARD_STATE; else process.env.PLUGBOARD_STATE = saved;
    }
  });
});
