import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { unresolvedKeys } from "./audit";
import { captureConnectorSchemas } from "./bridge/capture";
import type { ConnectorServer } from "./bridge/client";
import { annotationsOf, connectorId, loadIndex, loadManifest, manifestIds, saveIndex, toolHash, type Manifest, type ManifestTool } from "./cache";
import { BIN, prepare, profileName } from "./call";
import { invoke } from "./core";
import { authStatus, claudePath, claudeVersion, connectClaude, costGuard } from "./claude";
import { DirectSession, directEnabled } from "./direct";
import { AxiError } from "axi-sdk-js";
import { asAxiError, EXIT } from "./errors";
import { cacheDir, claudeVersionsDir, collapseHome, onWindowsDrive, platformLabel, policyPath, saveJson, saveRecord, stateDir, windowsClaudeFromWSL } from "./platform";
import { classify, DEFAULT_ALIASES, loadPolicy, matches, probeTools, profileFor, type Policy, type Profile } from "./policy";

type Status = "ok" | "warn" | "fail" | "info";
type Check = { check: string; status: Status; detail: string };

/** Try probe tools in order. Only a connector rejecting a bare call moves on to the next tool;
 * a timeout, auth failure or rate limit means the connector itself is down. */
export async function probe<T extends { name: string }>(tools: T[], call: (tool: T) => Promise<void>): Promise<{ tool?: T; ms?: number; error?: string }> {
  let error = "";
  for (const tool of tools) {
    const t0 = Date.now();
    try { await call(tool); return { tool, ms: Date.now() - t0 }; } catch (e) {
      error = `${tool.name}: ${(e as Error).message}`;
      if (e instanceof AxiError && e.code !== "UPSTREAM_ERROR" && e.code !== "VALIDATION_ERROR") break;
    }
  }
  return { error };
}

const KNOWN_MESSAGE_TYPES = new Set(["control_response", "system"]);
export const doctorPath = () => join(stateDir(), "doctor.json");
/** The last result, if one was saved whole; a file that doesn't parse counts as none, so it can't break the home view. */
export const lastDoctor = (): Record<string, any> | undefined => {
  try { return existsSync(doctorPath()) ? JSON.parse(readFileSync(doctorPath(), "utf8")) : undefined; } catch { return undefined; }
};

/** Connectors a profile names explicitly: those are required; `*:` patterns require nothing. */
export const requiredConnectors = (profile: Profile) =>
  [...new Set(profile.allow.map(p => p.slice(0, p.indexOf(":"))).filter(id => !id.includes("*")))];

export async function doctor(argv: string[]) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    as: { type: "string" }, schemas: { type: "boolean" }, strict: { type: "boolean" }, out: { type: "string" }
  } });
  const policy: Policy = loadPolicy();
  const profile = profileName(values as Record<string, string>);
  const checks: Check[] = [];
  const help: string[] = [];
  const blind = new Set<string>();
  let broken = false;
  const add = (check: string, status: Status, detail: string, remedy?: string) => {
    checks.push({ check, status, detail });
    if (remedy && status !== "ok" && status !== "info") help.push(remedy);
  };

  // A protocol failure, explained as asAxiError does (a sandbox, say); otherwise the remedy for a breaking update.
  const protocolFail = (prefix: string, error: unknown) => {
    const e = asAxiError(error);
    const remedy = e.suggestions.find(h => !h.includes("plugboard doctor") && !h.includes("breaking update"));
    add("protocol", "fail", prefix + e.message, remedy ?? "Pin claude_path to the last good version, or wait for a bridge fix");
  };

  // 0: platform, and plugboard's own directories (WSL: not on the Windows drive)
  const onC = [cacheDir(), stateDir(), policyPath()].filter(dir => onWindowsDrive(dir));
  add("platform", onC.length ? "warn" : "ok", platformLabel() + (onC.length ? `; on the Windows drive (slow, file modes ignored): ${onC.join(", ")}` : ""),
    "Keep PLUGBOARD_CACHE, PLUGBOARD_STATE and PLUGBOARD_POLICY inside the Linux home");

  // 1–3: binary, version, login (no protocol needed)
  const path = claudePath(policy);
  const version = existsSync(path) ? claudeVersion(path) : undefined;
  const windowsClaude = version ? undefined : windowsClaudeFromWSL();
  add("binary", version ? "ok" : "fail", version ? collapseHome(path) : `${collapseHome(path)} missing or not runnable`
    + (windowsClaude ? `; found Windows' ${windowsClaude}, which is a separate install with its own login` : ""),
    windowsClaude ? "Install Claude Code inside WSL (curl -fsSL https://claude.ai/install.sh | bash), then `claude` and /login"
      : "Install Claude Code, or set claude_path in policy.toml");
  const index = loadIndex();
  const tested = index?.testedVersions ?? [];
  const lastGood = tested.at(-1);
  const versions = version ? claudeVersionsDir(path) : undefined; // where the native installer keeps old versions
  if (version) add("version", tested.includes(version) ? "ok" : "warn", tested.includes(version) ? `${version} (tested)` : `${version} untested; checks below decide`,
    lastGood && versions ? `Last good: ${lastGood}; to roll back set claude_path = "${collapseHome(join(versions, lastGood))}"` : undefined);
  if (lastGood && versions && !existsSync(join(versions, lastGood)))
    add("rollback", "warn", `last good version ${lastGood} is no longer on disk`);
  const auth = version ? authStatus(path) : undefined;
  add("login", auth?.loggedIn ? "ok" : "fail", auth ? (auth.loggedIn ? `logged in (${auth.method ?? "?"})` : "not logged in") : "auth status unavailable", "Run `claude` and /login");

  // 9: policy (no spawn)
  let prof: Profile | undefined;
  try {
    prof = profileFor(policy, profile);
    const ids = manifestIds();
    const tools = ids.flatMap(id => (loadManifest(id)?.tools ?? []).map(t => ({ id, t })));
    const dead = [...prof.allow, ...prof.deny, ...policy.overrides.read, ...policy.overrides.write]
      .filter(p => !tools.some(({ id, t }) => matches(p, id, t.name)));
    const known = Object.keys(index?.connectors ?? {});
    const unknownAliases = Object.entries(policy.aliases).filter(([a, id]) => DEFAULT_ALIASES[a] !== id && !known.includes(id)).map(([a]) => a);
    add("policy", dead.length || unknownAliases.length ? "warn" : "ok",
      `${policy.source ? collapseHome(policy.source) : "built-in default"}; profile ${profile} (${prof.mode})`
      + (dead.length ? `; entries matching nothing: ${dead.join(", ")}` : "") + (unknownAliases.length ? `; aliases to unknown connectors: ${unknownAliases.join(", ")}` : ""),
      "Edit policy.toml, or run `plugboard refresh` if the tools are new");
  } catch (error) { add("policy", "fail", (error as Error).message, "Fix policy.toml"); }
  const required = prof ? requiredConnectors(prof) : [];

  /** The same read as calls make it: direct to the connector proxy, never through Claude Code. A proxy that
   * answers but fails a read Claude Code made leaves the connector's calls failing with no fallback: blind. */
  async function checkDirect(id: string, manifest: Manifest, tools: ManifestTool[]) {
    const session = new DirectSession([manifest], async () => { throw new Error("not direct"); });
    const result = await probe(tools, tool => invoke(session, prepare(policy, manifest, tool, {}, false), 30_000).then(() => undefined));
    if (result.tool) add(`direct:${id}`, "ok", `${result.tool.name} in ${result.ms}ms`);
    else if (session.notDirect) add(`direct:${id}`, "warn", `calls go through Claude Code: ${session.notDirect}`, `Run \`${BIN} refresh\` or \`claude /login\` if this persists`);
    else {
      blind.add(id);
      add(`direct:${id}`, "fail", `the connector proxy failed a read Claude Code made: ${(result.error ?? "").slice(0, 160)}`, "Set PLUGBOARD_DIRECT=0 until Plugboard is updated");
    }
  }

  // 4–8, 10: protocol, cost, connectors, drift, live reads
  let readyMs: number | undefined;
  let costText: string | undefined;
  if (version && auth?.loggedIn !== false) {
    const started = Date.now();
    let client;
    try {
      client = await connectClaude(policy);
      let servers: ConnectorServer[] = [];
      try {
        servers = await client.waitForServers();
        readyMs = Date.now() - started;
        const types = Object.keys(client.messageTypes);
        const unknown = types.filter(t => !KNOWN_MESSAGE_TYPES.has(t));
        add("protocol", unknown.length ? "warn" : "ok", `initialize + mcp_status ok in ${(readyMs / 1000).toFixed(1)}s${unknown.length ? `; new message types: ${unknown.join(", ")}` : ""}`);
      } catch (error) {
        broken = true;
        protocolFail("mcp_status: ", error);
      }
      // 6: connectors
      for (const server of servers) {
        const id = connectorId(server.name);
        const needed = required.includes(id);
        if (server.status === "connected" || !needed) continue;
        blind.add(id);
        add(`connector:${id}`, "fail", `${server.status} (required by ${profile})`,
          `Reconnect ${server.name.replace(/^claude\.ai /, "")} in claude.ai → Settings → Connectors`);
      }
      for (const id of required) if (!servers.some(s => connectorId(s.name) === id)) {
        blind.add(id);
        add(`connector:${id}`, "fail", `not listed by Claude Code (required by ${profile})`, `Check the connector name in policy.toml`);
      }
      const connected = servers.filter(s => s.status === "connected").length;
      const idle = servers.filter(s => s.status !== "connected" && !required.includes(connectorId(s.name))).map(s => connectorId(s.name));
      add("connectors", blind.size ? "fail" : "ok", `${connected}/${servers.length} connected${blind.size ? `; blind: ${[...blind].join(", ")}` : ""}`
        + (idle.length ? `; not connected, not required: ${idle.join(", ")}` : ""));
      // 7: tool drift against the cache
      for (const server of servers.filter(s => s.status === "connected")) {
        const id = connectorId(server.name);
        const manifest = loadManifest(id);
        if (!manifest) { add(`drift:${id}`, "warn", "not in the cache", `Run \`${BIN} refresh ${id}\``); continue; }
        const live = new Map(server.tools.map(t => [t.name, annotationsOf(t)]));
        const cached = new Map(manifest.tools.map(t => [t.name, t.annotations]));
        const added = [...live.keys()].filter(n => !cached.has(n) && !manifest.hidden?.includes(n));
        const removed = [...cached.keys()].filter(n => !live.has(n));
        const lostRead = [...cached].filter(([n, a]) => a?.readOnlyHint === true && live.has(n) && live.get(n)?.readOnlyHint !== true).map(([n]) => n);
        const gainedRead = [...cached].filter(([n, a]) => a?.readOnlyHint !== true && live.get(n)?.readOnlyHint === true).map(([n]) => n);
        if (!added.length && !removed.length && !lostRead.length && !gainedRead.length) continue;
        add(`drift:${id}`, "warn", [
          added.length && `+${added.length} (${added.slice(0, 5).join(", ")})`, removed.length && `-${removed.length} (${removed.slice(0, 5).join(", ")})`,
          lostRead.length && `LOST readOnlyHint, now write: ${lostRead.join(", ")}`, gainedRead.length && `gained readOnlyHint (stays write until refresh): ${gainedRead.join(", ")}`,
        ].filter(Boolean).join("; "), `Run \`${BIN} refresh ${id}\` to accept the new tool list`);
      }
      // 8: schema drift (--schemas)
      if (values.schemas && !broken) {
        try {
          const { schemas } = await captureConnectorSchemas({ claudePath: path });
          const changed: string[] = [];
          for (const id of manifestIds()) for (const t of loadManifest(id)?.tools ?? []) {
            const fresh = schemas.find(s => s.name === t.sourceName);
            if (fresh && toolHash({ ...t, inputSchema: fresh.inputSchema as Record<string, any> }) !== toolHash(t)) changed.push(`${id}:${t.name}`);
          }
          const used = prof ? changed.filter(k => prof!.allow.some(p => matches(p, k.split(":")[0]!, k.split(":")[1]!))) : [];
          add("schema-drift", changed.length ? "warn" : "ok", changed.length ? `${changed.length} changed (${used.length} used by ${profile}): ${changed.slice(0, 8).join(", ")}` : `${schemas.length} schemas unchanged`,
            `Run \`${BIN} refresh\`, then check transforms for changed parameters`);
        } catch (error) { broken = true; add("schema-drift", "fail", `capture failed: ${(error as Error).message}`); }
      }
      // 10: one cheap read per required connector: the first of its argument-free read tools that succeeds
      for (const id of required) {
        const manifest = loadManifest(id);
        const tools = manifest ? probeTools(policy, profile, id, manifest.tools) : [];
        if (blind.has(id) || broken || !manifest) continue; // already reported (a missing manifest by drift)
        // A connector left unprobed still gets a line, so it never looks checked when it isn't.
        if (!tools.length) { add(`read:${id}`, "info", `not checked: ${profile} allows no read tool here that runs without arguments`); continue; }
        const result = await probe(tools, tool => invoke(client!, prepare(policy, manifest, tool, {}, false), 30_000).then(() => undefined));
        if (result.tool) {
          add(`read:${id}`, "ok", `${result.tool.name} in ${result.ms}ms`);
          if (directEnabled()) await checkDirect(id, manifest, tools);
        } else {
          blind.add(id);
          add(`read:${id}`, "fail", (result.error ?? "").slice(0, 160), `Reconnect ${manifest.connectorName.replace(/^claude\.ai /, "")} in claude.ai → Settings → Connectors`);
        }
      }
      if (!directEnabled()) add("direct", "info", "off: every call starts Claude Code (PLUGBOARD_DIRECT=0, or a custom CLAUDE_CONFIG_DIR)");
      // 5: zero cost (after every call above)
      try {
        costText = await costGuard(client);
        add("zero-cost", "ok", "$0.0000, 0 tokens");
      } catch (error) { broken = true; add("zero-cost", "fail", (error as Error).message, "Stop: a model was reached. Investigate before using the bridge again"); }
    } catch (error) {
      broken = true;
      protocolFail("", error);
    } finally { await client?.close(); }
  }

  // 11: audit
  const unresolved = unresolvedKeys();
  add("audit", unresolved.length ? "warn" : "ok", unresolved.length ? `${unresolved.length} write(s) with unknown outcome: ${unresolved.map(u => u.key).join(", ")}` : "no unresolved writes",
    "Check each destination, then `plugboard audit resolve <key> --sent|--not-sent`");

  // A version is "tested" once protocol, cost and live reads pass on it.
  const failedCore = checks.some(c => c.status === "fail" && (c.check === "protocol" || c.check === "zero-cost" || c.check.startsWith("read:")));
  const unsaved: string[] = []; // records doctor keeps; a folder it can't write (an agent's sandbox) must not fail it
  if (version && readyMs !== undefined && costText && !failedCore && index && !tested.includes(version)) {
    const error = saveRecord(join(cacheDir(), "index.json"), () => saveIndex({ ...index, testedVersions: [...tested, version] }));
    if (error) unsaved.push(error);
  }

  const warned = checks.some(c => c.status === "warn");
  const otherFail = checks.some(c => c.status === "fail");
  let exitCode = broken || !version ? EXIT.BRIDGE_BROKEN : blind.size ? EXIT.PARTIAL : otherFail ? 1 : warned && values.strict ? EXIT.PARTIAL : EXIT.OK;
  const result = {
    claude: version ? `${version}${tested.includes(version) ? " (tested)" : ""}` : "missing",
    bridge: broken || !version ? "broken" : `ok${readyMs ? ` (ready ${(readyMs / 1000).toFixed(1)}s, $0.0000, 0 tokens)` : ""}`,
    profile, checks, blind: [...blind], exit: exitCode, at: new Date().toISOString(),
  };
  const saveError = saveJson(doctorPath(), result);
  if (saveError) unsaved.push(saveError);
  if (unsaved.length) {
    add("state", "warn", `not saved: ${unsaved.join("; ")}`, "Let plugboard write its state and cache folders (in a sandbox, add them as writable roots)");
    if (values.strict && exitCode === EXIT.OK) exitCode = EXIT.PARTIAL; // a warning, as any other under --strict
    result.exit = exitCode;
  }
  const remedies = [...new Set(help)];
  const out = values.out === "json" ? JSON.stringify({ ...result, help: remedies }) : { ...result, ...(remedies.length ? { help: remedies } : {}) };
  return { out, exitCode };
}

