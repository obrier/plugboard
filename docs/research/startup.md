# Faster start for claude.ai connector calls

Question: can plugboard reach claude.ai connector tools faster than spawning Claude Code and waiting
for discovery, without ever reaching a model?

Measured on Arindo's Mac, 5 November 2026, Claude Code 2.1.318, plugboard v0.1.2 (origin/main 3737717).
Probes are in `research/startup/`; every number below names the command that produced it.

## Summary

| Option | Evidence | Saving per call (Google Calendar list_calendars) |
|---|---|---|
| A. Direct call to the MCP proxy, Claude Code as fallback | works; single runs only, the benchmark was denied (see below) | about 1.1 s (1.84 s → about 0.7 s), not yet a median |
| B. Keep a Claude Code process warm (daemon), reuse it per call | measured, 8 runs × 8 warm calls | about 1.2 s on every call after the first |
| C. One connector, `stateless` with a `cachedInitResponse`, list fetch off | measured, 8 alternating runs | about 0.25 s of discovery, 0.17 s total |
| D. Send `mcp_call` without polling `mcp_status` | measured, 9 alternating runs | none |
| E. The Agent SDK (`startup()`, `prewarm()`) | sourced | same as B; the SDK spawns the same binary |
| F. A connector or tool cache on disk | sourced | none: the discovery cache excludes claude.ai connectors |
| G. `--bare` | sourced | not usable: never reads the OAuth login, so no connectors |

Recommendation: A as the hot path, with plugboard's Claude Code path as the fallback, once its
benchmark has run; B only if calls come in bursts. C is a small, safe gain on the fallback path.

## Where the time goes today

`bun research/startup/window.ts <dir>` runs Claude Code with plugboard's arguments plus `--debug-file`
and prints each debug line's offset from spawn (URLs elided, lines naming a token dropped):

| Offset | What |
|---|---|
| 0 → ~370 ms | process start, settings, plugins, skills; `initialize` answers at ~400 ms |
| ~370 ms | `[claudeai-mcp] Fetching from …/v1/mcp_servers?limit=1000` (the connector list) |
| ~730 ms | `Fetched 6 servers` (the list leg is about 330–360 ms) |
| ~740 ms | Google Calendar: `Stateless claudeai-proxy — resolving MCP initialize from cached projection`, `Successfully connected … in 2ms` |
| ~740 → ~1240 ms | `tools/list` through the proxy (not logged; the gap until `mcp_status` shows `connected`) |
| then | `tools/call`, about 500–600 ms, the connector's own time |

Context7, which is not stateless, does a real `initialize` (`Successfully connected … in 318ms`).

So the 0.8 s of discovery is two network legs in sequence: the connector list (~350 ms) and
`tools/list` (~500 ms). For stateless connectors the MCP `initialize` is already skipped: the list
endpoint returns a `cached_init_response` when the client sends its capabilities in an
`anthropic-mcp-client-capabilities` header (gate `tengu_mcp_stateless_skip_init`, default on).

## A. Direct call to the proxy

How Claude Code reaches a `claudeai-proxy` server (from the binary's strings):

- URL: `MCP_PROXY_URL` + `MCP_PROXY_PATH` = `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}`, where
  `server_id` is the connector's `mcpsrv_…` id.
- Transport: MCP streamable HTTP (`POST`), with the GET notification stream disabled.
- Headers: `Authorization: Bearer <claude.ai OAuth access token>`, `User-Agent`,
  `Accept-Encoding: identity`, `X-Mcp-Client-Session-Id: <session uuid>`. No `anthropic-beta`.
- Auth handling (`function Rn`): on a 401 without an `X-Mcp-Error-Code` header it refreshes the OAuth
  token and retries once; a 401 with that header is returned as is.
- The login is the keychain item `Claude Code-credentials`, account `$USER` (`qz()` and `R0()` in the
  binary), a JSON with `claudeAiOauth.accessToken`, `expiresAt` and `scopes`; the list needs the
  `user:mcp_servers` scope.
- The connector list: `GET https://api.anthropic.com/v1/mcp_servers?limit=1000` with
  `anthropic-beta: mcp-servers-2025-12-04` and `anthropic-version: 2023-06-01`.

Neither endpoint is a model endpoint; no `/v1/messages` request is made.

What was run (with Arindo's go; the scripts read the token in memory and print no token, header value
or keychain output):

`bun research/startup/list.ts` → `200` in 289 ms, 6 connectors, with `id`, `display_name`, `url`,
`stateless`, `tools`, `cached_init_response` and others. Google Calendar, Gmail and Google Drive are
`stateless: true`; Context7, Claude Docs and Slack are not. Without the client-capabilities header,
`cached_init_response` comes back empty.

`bun research/startup/direct.ts <id> <tool> [args]`, single runs:

| Command | Result |
|---|---|
| `direct.ts mcpsrv_01UkR3rNSMJYp6xdyb7WgByL list_calendars` | `200`, one `tools/call` with no `initialize`, result in 647 ms after start, keychain read 14 ms |
| same with `--init` (initialize, initialized, tools/call) | `200`, 986 ms; the server issues no `Mcp-Session-Id` |
| `direct.ts mcpsrv_01BvFQL9hDhrqH33N3bdr4px resolve-library-id '{"libraryName":"bun","query":"spawn"}'` | `200`, 1670 ms, no `initialize` needed even though Context7 is not stateless |

For comparison, `bun research/startup/bench-direct.ts 8 <repo> -- "bun src/cli.ts google-calendar list-calendars --select x"`:
median **1836 ms** (min 1712, max 1872).

The alternating benchmark of the two
(`bench-direct.ts 9 … -- "bun src/cli.ts …" "bun research/startup/direct.ts …"`) was denied by the
session's permission classifier ("Credential Exploration"), so there is no median for the direct path
yet. To finish it, Arindo runs or allows:

```sh
cd ~/Developer/plugboard-research
bun research/startup/bench-direct.ts 9 . -- \
  "bun src/cli.ts google-calendar list-calendars --select x" \
  "bun research/startup/direct.ts mcpsrv_01UkR3rNSMJYp6xdyb7WgByL list_calendars"
```

No macOS keychain prompt appeared in any run.

### Failure signals the fallback would key on

Each was produced by `direct.ts` (the made-up token with `--bad-token`, the wrong id by hand):

| Signal | Seen as |
|---|---|
| No login in the keychain | `security` exits non-zero |
| Token about to expire | `expiresAt` within a margin (the script uses 60 s) |
| Bad or expired token | HTTP `401`, JSON body `Invalid bearer token`, no `X-Mcp-Error-Code`, in 166 ms |
| Wrong or removed connector id | HTTP `404`, `Server not found`, in 232 ms |
| Unknown tool (renamed or removed) | HTTP `200`, JSON-RPC error `-32602` `Tools Call name is not found in the list of tools`, in 397 ms |
| Proxy moved or down | network error, or any status other than 200 |
| Tool ran and failed | `result.isError: true`: a real result, not a reason to fall back |

Falling back is safe for every signal above except a timeout during `tools/call`: as plugboard's own
comment says, a timeout does not prove the tool did not run. For write tools that one must not be
retried through Claude Code.

### Token expiry

Claude Code refreshes the token itself (on expiry before a request, and on a 401). The hot path
should not refresh: a refresh would rotate the refresh token outside Claude Code's store (not tested,
so not proven). Falling back on a 401 or an expiring token lets Claude Code refresh and write the
keychain, and the next hot call reads the new token. The token seen had about 4.2 hours left.

### Ids

The ids come from the list endpoint (289 ms) or from `mcp_status` (`config.id`); feat/one-connector
already caches them in plugboard's manifest at refresh. A wrong id fails fast with `404`, so a stale
cache costs one fallback.

### Open questions for Arindo

- Using Claude Code's OAuth login from another program: whether that fits Anthropic's terms for the
  claude.ai login is a decision for him, not something these tests answer.
- `User-Agent`: the probe sent `plugboard-research/0.1` and the proxy accepted it.
- The cost guard: there is no Claude Code session, so `get_session_cost` does not apply. The guarantee
  becomes structural: the hot path only talks to `mcp-proxy.anthropic.com` (and the list endpoint).

## B. A warm Claude Code process

`bun research/startup/bench.ts 8 "--warm 8"` (each run: a fresh process, one call, then 8 more calls in
the same process): first call median total 1764 ms (initialize 400, discovered 1234, call 559); the
warm calls' median **548 ms**, the connector's own time. A process that stays up saves the whole
start (about 1.2 s) on every call after the first. Cost: a resident process (the SDK documents a
parked one at 230–260 MB), and plugboard becomes a daemon with its own lifecycle (login changes,
Claude Code updates, crashes). That is the same trade the SDK's `prewarm()` makes.

## C. One connector, stateless, with a cached init

Already known (feat/one-connector): `--strict-mcp-config --mcp-config` with only
`{type: "claudeai-proxy", url, id}` gives no gain. The debug log shows why: without `stateless` and a
cached init it does a real `initialize` (504 ms), which costs more than the list fetch it skips.

The `--mcp-config` schema accepts `stateless` and `cachedInitResponse` for `claudeai-proxy` (schema
`VOs` in the binary). `cachedInitResponse.protocolVersion` must be one of
`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`; `2026-07-28` is refused
(`carries unsupported protocolVersion … falling back to real initialize`).

`bun research/startup/bench.ts 8 "" "--config one.json" "--config one-stateless.json"`:

| Variant | initialize | discovered | call | total |
|---|---|---|---|---|
| baseline | 410 | 1264 | 571 | 1826 |
| one connector (`one.json`) | 439 | 1385 | 562 | 1961 |
| one connector, stateless + cached init (`one-stateless.json`) | 415 | **1011** | 661 | **1661** |

All medians in ms, all `zeroCost: true`. Claude Code still fetches the connector list in parallel; with
`ENABLE_CLAUDEAI_MCP_SERVERS=false` it does not, and the call still works (one run: discovered 934 ms,
total 1460 ms). Forcing `stateless` on Context7, which is not stateless, also worked (one run).
The floor is `tools/list` (~500 ms), which `claudeai-proxy` configs have no way to skip.

## D. Calling without polling

Claude Code's `mcp_call` brings a server up on demand and waits for it (SDK types, `mcp_call`).
`bun research/startup/bench.ts 9 "" "--no-wait"`: baseline total 1768 ms, no-wait 1785 ms. Polling
every 50 ms costs nothing measurable.

## E. The Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` 0.3.318 (npm, inspected from its tarball): its `manifest.json` names
Claude Code 2.1.318 and ships the same native `claude` binary through platform packages; it drives it
over the same stream-json control protocol. `Query.mcpServerStatus()` is `mcp_status`; there is no
public method for `mcp_call`. `startup()` "saves only the spawn"; `prewarm()` parks a spare process
with MCP handshakes done, to be claimed later (`@alpha`). Both are option B. The Python SDK was not
inspected.

## F. Disk caches

- `~/.claude/state/mcp-discover-verdicts.json` holds protocol-era verdicts for stdio servers,
  `~/.claude/mcp-needs-auth-cache.json` the names of servers needing auth, and the per-cwd logs under
  `~/Library/Caches/claude-cli-nodejs/*/mcp-logs-*` timestamps: none holds a connector list or tools.
  The per-cwd logs are useful, though: they give each connector's connect and call times.
- The binary has an MCP discovery cache (`mcp-discovery-cache`, `MCP_DISCOVERY_CACHE_TTL_S`,
  gate `tengu_mcp_discovery_cache_enable`), but its eligibility (`function je`) refuses any transport
  other than `http` and `sse`, so `claudeai-proxy` connectors are never cached. No such folder
  exists on this Mac.
- `~/.claude.json` keeps `claudeAiMcpEverConnected`, names only.

## Sources

- Claude Code 2.1.318 binary strings (`strings` dump, searched with `research/startup/ctx.ts` and
  `at.ts`): `ne()` (connector list fetch), `fOn()`/`U()` (client-capabilities header), `Lo()`/`Fo()`/`No()`
  (cached init and discover), the `claudeai-proxy` transport branch, `Rn()` (bearer and 401 handling),
  `qz()`/`R0()` (keychain item), `MCP_PROXY_URL`/`MCP_PROXY_PATH`, the discovery cache's `je()`.
- `@anthropic-ai/claude-agent-sdk` 0.3.318: `sdk.d.ts` (`prewarm`, `startup`, `mcpServerStatus`,
  `mcp_call`, `mcp_status`), `manifest.json`, `package.json`.
- `claude --help` (`--bare`).
- Probes: `research/startup/probe.ts`, `bench.ts`, `window.ts`, `status.ts`, `direct.ts`, `list.ts`,
  `bench-direct.ts`; configs `one.json`, `one-stateless.json`, `context7-stateless.json`.

## Benchmark of option A (run 2026-11-05, after Arindo approved the token step)

`bun research/startup/bench-direct.ts 9 . -- "bun src/cli.ts google-calendar list-calendars --select x" "bun research/startup/direct.ts mcpsrv_01UkR3rNSMJYp6xdyb7WgByL list_calendars"`, 9 alternating runs, every run exit 0:

| Command | median | min | max |
|---|---|---|---|
| plugboard 0.1.2 CLI | 2010 ms | 1862 | 2286 |
| direct proxy call | 583 ms | 530 | 852 |

The direct script has no policy, audit or output shaping; plugboard's own startup measured 45–70 ms earlier, so a hot path inside plugboard would land near 0.65 s.
