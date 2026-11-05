# The library: @obrier/plugboard

A design review of the public API before it ships, now that most calls go straight to the connector proxy (#30) and Claude Code is only the fallback. Decisions are recorded as they are made; each says what was chosen, why, and what it needs.

## Agenda

1. What a user holds: functions or an object. **Decided.**
2. The shape of a call: arguments, names, options.
3. Writes: plan, approval and send.
4. What comes back: results and errors (codes, and the names that still say "bridge").
5. Transports and their configuration: direct, Claude Code, and the names `connect`, `Session`, `claude_path`, `PLUGBOARD_DIRECT`.
6. Batch as a stream.
7. Packaging: ESM, Node and Bun versions, what is bundled.

## 1. Functions that share a session, plus `createPlugboard()`

Chosen 2026-11-05.

```ts
import { call, plan, write } from "@obrier/plugboard";
await call("google-calendar", "list_events", { calendarId: "primary" }); // opens the shared default session
await call("gmail", "search_threads", { query: "invoice" });             // reuses it

import { createPlugboard } from "@obrier/plugboard";
const pb = createPlugboard({ policy: "./policy.toml", profile: "reader" }); // the same API, isolated
```

- The module functions are a default instance, created on first use. `createPlugboard()` makes another, with its own policy, profile and session.
- Policy is read once per instance. The profile is set per instance and can be overridden per call; the core judges every call as the CLI does.

What the shared session needs that today's session doesn't do:

1. **It grows on demand.** Today a session is opened for the connectors known up front (the CLI's one call, batch's lines). The shared one takes connectors as they are first called: on the direct path that is only an ID lookup; once fallen back to Claude Code, it waits for that connector's discovery.
2. **It never keeps a program from exiting.** The direct path holds no process. A Claude Code fallback is a child process: it closes itself when idle (about 30 s) and on process exit; `close()` stays for anyone who wants to be explicit. Checked on 2026-11-05: Node's fetch keeps no idle socket holding the event loop (a fetch to a server in another process, then nothing: Node 22 exits 64 ms after, Node 26 20 ms, Bun 1 ms). Under Bun a child whose output is read keeps the program running even unref'd, so both runtimes spawn through `node:child_process`.
3. **It stays valid over hours.** Before each direct call it checks the login's expiry and re-reads the login when close, since a Claude Code fallback may have renewed it.

## 2. A call is one object, the shape of a batch line

Chosen 2026-11-05, over positional arguments (`call(connector, tool, args, options)`).

```ts
await call({ connector: "google-calendar", tool: "list_events", args: { calendarId: "primary" } });
await call({ connector: "gcal", tool: "list-events", args: { calendarId: "primary" }, profile: "reader", timeoutMs: 30_000, signal });
```

- The same object as a batch line, `{ connector, tool, args }`, with the call's options beside it: a line can be passed to `call()` as it is, and new fields don't change any order.
- `connector` takes an ID or a policy alias; `tool` takes the tool's name, the CLI's short name or its kebab form, as the core resolves them today.
- `timeoutMs` is the CLI's `--deadline`. `signal` is the usual `AbortSignal`: a read cancelled is dropped; a write cancelled after it was sent is recorded as an unknown outcome, like a timeout.

## 3. Writes: `write(plan, { key })`

Chosen 2026-11-05, over `write({ ...request, key, expectHash })`.

```ts
const p = plan({ connector: "slack", tool: "send_message", args: { channel_id: "D1", message: "hi" }, profile: "executor" });
const sent = await write(p, { key: "reply-42" });  // { sent: true, key, ref, value }, or { replayed: true, key, ref }
```

- `call()` only reads. A write tool passed to `call()` is refused (POLICY_DENIED) with a pointer to `write()`.
- A plan is plain JSON and can travel: an agent plans and saves it, a person approves it, a script runs `write(JSON.parse(saved), { key })`. `write` trusts nothing in the object: it plans the plan's request again and sends only if the hash still matches the plan's, so a plan edited in transit is refused.
- So a plan carries the request it was made from (`request: { connector, tool, args, profile }`), not only the payload after transforms; planning the payload again would apply a transform such as `"-1d"` twice. A relative time in a write's args resolves to a new instant when it is planned again, changing the hash: such a write is refused, as `--write --expect-hash` refuses it in the CLI today.
- Every check stays in the core: the write profile, the key, the hash, the claim in the audit log, replaying a key already sent, and refusing writes inside a Claude Code session unless the profile allows it.

## 4a. A read returns `{ value, raw, via }`

Chosen 2026-11-05, over returning the value itself.

```ts
const { value } = await call({ connector: "google-calendar", tool: "list_calendars" });
const r = await call({ connector: "drive", tool: "fetch", args: { id } });
r.raw.content; // the MCP result untouched: images, several blocks
r.via;         // "direct" | "claude-code"
```

- `value` is the result as the CLI prints it (`unwrap`: `structuredContent`, else the text blocks parsed as JSON, else `{ text }` or `{ content }`); `raw` is the MCP result as the connector sent it.
- `via` names the path that served the call, so a script can see it fell back to Claude Code without running `doctor`.
- It lines up with `write()`'s result, `{ sent, key, ref, value }` or `{ replayed, key, ref }`.

## 4b. `PlugboardError`, and `BRIDGE_BROKEN` becomes `UNREACHABLE`

Chosen 2026-11-05.

```ts
import { call, PlugboardError } from "@obrier/plugboard";
try { await call(req); } catch (e) {
  if (e instanceof PlugboardError && e.code === "AUTH_REQUIRED") console.log(e.hints);
}
```

- The library throws its own `PlugboardError` (`code`, `message`, `hints`, `exitCode`), not `axi-sdk-js`'s `AxiError`: users don't import a dependency's type to catch ours.
- The codes are the CLI's. `BRIDGE_BROKEN` is renamed `UNREACHABLE`: Plugboard couldn't reach your connectors by any path (the proxy refused, and Claude Code couldn't start, its protocol changed, or a sandbox blocked it). Exit code 10 is unchanged. The skill and the harness guides document the exit number, not the string; the rename ships with a release note, in the CLI and the library alike.
- `COST_GUARD` keeps its name: a model was reached.

## 5. One `transport` setting: `auto`, `direct`, `claude-code`

Chosen 2026-11-05, over keeping `PLUGBOARD_DIRECT`.

| `transport` | Behaviour |
|---|---|
| `"auto"` (default) | Direct to the connector proxy, falling back to Claude Code when the proxy refuses |
| `"direct"` | Never starts Claude Code; a refusal is `UNREACHABLE` (sandboxes that block spawning, servers that must run no child process) |
| `"claude-code"` | Always through Claude Code |

```ts
await call({ ...req, transport: "claude-code" }); // one call
createPlugboard({ transport: "direct" });         // one instance
```
```toml
transport = "auto"  # policy.toml: the CLI and the library
```

- Also `PLUGBOARD_TRANSPORT` in the environment. Narrowest wins: call, instance, environment, policy.
- The values are the words `via` reports.
- `PLUGBOARD_DIRECT=0`, released in 0.1.3, is read as `claude-code` for one release, then dropped.
- `claude_path` and `PLUGBOARD_CLAUDE` keep their names: they say where Claude Code is, which `refresh`, `doctor` and the fallback still need.
- `connect`, `Session`, `DirectSession` and `src/bridge/` are internal, not part of the public API.

## 6. Batch: async iterables in and out

Chosen 2026-11-05, over a promise of an array or a callback per result.

```ts
for await (const r of batch(requests, { concurrency: 4 })) {
  if (r.ok) save(r.id, r.value);
  else console.warn(r.id, r.error.code, r.error.hints);
}
const all = await Array.fromAsync(batch(requests, { ordered: true }));
```

- Input: any iterable or async iterable of the `call()` object, with an optional `id`, so a producer can feed it while results come back. The CLI's `batch` reads stdin the same way, line by line, instead of all at once.
- Output: completion order by default, input order with `ordered: true`. `{ id, ok: true, value, raw, via }` or `{ id, ok: false, error }`; a line's failure is a result, not an exception.
- `UNREACHABLE` or `COST_GUARD` fails the remaining lines and ends the batch. Breaking out of the loop cancels the lines still running.
- Reads only: a write tool is refused for its line. A write is one approved plan, sent with `write()`.
- The options are today's: `concurrency`, a per-connector limit, `ordered`, a time budget; rate limits and read timeouts are retried as today.
- One batch in the core: the CLI adds only reading stdin and printing JSON lines.

## 7. Packaging

Chosen 2026-11-05, over regular npm dependencies and over shipping the CLI on npm too.

- `@obrier/plugboard` on npm is the library only: ESM, with TypeScript types. The CLI stays a Homebrew binary.
- Its four runtime dependencies (`ajv`, `ajv-formats`, `chrono-node`, `smol-toml`) are bundled in, at the lockfile's versions: installing it fetches nothing else. The CLI's own (`@toon-format/toon`, `filtrex`, `axi-sdk-js`) stay out: with `PlugboardError`, the core no longer needs `axi-sdk-js`.
- Node ≥ 22 (CI's oldest, the first with `Array.fromAsync`) and Bun ≥ 1.4.
- One version for both: the `v*` tag that releases Homebrew also publishes to npm, with provenance. npm trusts the release workflow's `npm` job (trusted publishing, environment `npm`): no token is stored. The trust was set before the first publish (`npm trust github … --allow-publish`), and 0.2.0, the first release, was published by that job (docs/RELEASING.md).

## Implementation, in order

Each a PR with tests and a review; the first two change what the CLI shows, so they ship in 0.2.0 with a release note.

1. **Errors and transport.** `PlugboardError` in the core (the CLI turns it into AXI output); `BRIDGE_BROKEN` → `UNREACHABLE`; the `transport` setting (call, instance, `PLUGBOARD_TRANSPORT`, policy), `PLUGBOARD_DIRECT=0` read as `claude-code` for one release; `via` on every result.
2. **The shared session.** Takes connectors on demand; a Claude Code fallback closes itself when idle and on exit; the login's expiry is checked before each direct call and the login read again when close.
3. **The library API.** `call`, `plan`, `write` and `createPlugboard`, with the default instance; a plan carries its request; the package's `exports`, build and types.
4. **Batch as a stream.** The core's batch takes and gives async iterables; the CLI reads stdin line by line.
5. **Publishing.** The release workflow publishes to npm with provenance; then 0.2.0.
