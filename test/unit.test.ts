import { describe, expect, test } from "bun:test";
import { AxiError } from "axi-sdk-js";
import { keyState } from "../src/audit";
import { mergeCapture, shortName, findTool, type Manifest } from "../src/cache";
import { canonical, payloadHash, refOf } from "../src/call";
import { classify as classifyError } from "../src/errors";
import { mergeArgs, parseFlags, toolHelp } from "../src/flags";
import { markdownOf, render, shape, unwrap } from "../src/output";
import { classify, decide, parsePolicy } from "../src/policy";
import { formatTime, parseTime } from "../src/time";
import { setupCommand } from "../src/cli";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(JSON.stringify(render({ raw: {}, value: { long }, format: "toon", full: false }))).toContain("cut at 1500");
    expect(render({ raw: {}, value: { long }, format: "json", full: false })).toBe(JSON.stringify({ long }));
    expect(render({ raw: { content: "r" }, value: {}, format: "raw", full: false })).toBe('{"content":"r"}');
  });
});

describe("errors, time, cache", () => {
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
    const installed = setupCommand(["hooks", "--project"], { homeDir: dir, projectDir: dir, execPath: "/usr/local/bin/plugboard", shouldInstall: () => true });
    expect(installed.claude).toBe(true);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toContain("plugboard");
    expect(setupCommand(["hooks", "--project", "--remove"], { homeDir: dir, projectDir: dir, execPath: "/usr/local/bin/plugboard" }).claude).toBe(false);
    expect(code(() => setupCommand(["nope"], { homeDir: dir, projectDir: dir }))).toBe("VALIDATION_ERROR");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
