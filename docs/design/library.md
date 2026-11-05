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
2. **It never keeps a program from exiting.** The direct path holds no process. A Claude Code fallback is a child process: it closes itself when idle (about 30 s) and on process exit; `close()` stays for anyone who wants to be explicit. To check: that Node's fetch keeps no idle socket holding the event loop.
3. **It stays valid over hours.** Before each direct call it checks the login's expiry and re-reads the login when close, since a Claude Code fallback may have renewed it.
