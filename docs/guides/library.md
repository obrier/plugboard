# From code

The same calls, with the same policy and safeguards, from TypeScript or JavaScript on Node 22+ or Bun 1.4+. The package, `@obrier/plugboard`, is published to npm from 0.2.0.

```bash
npm install @obrier/plugboard
```

It needs what the CLI needs: Claude Code, logged in, and your connectors' schemas captured once with `plugboard refresh` (see [Getting started](../getting-started.md)).

## Read

```ts
import { call } from "@obrier/plugboard";

const { value, raw, via } = await call({ connector: "google-calendar", tool: "list_events", args: { calendarId: "primary" } });
```

`call()` only reads; it returns `value` (as the CLI prints it), `raw` (the MCP result) and `via` (`direct` or `claude-code`).

Each call takes `profile`, `timeoutMs`, `signal` and `transport`.

## Write

A write: plan it, have its hash approved, then send it once under a key.

```ts
import { plan, write } from "@obrier/plugboard";

const p = plan({ connector: "slack", tool: "send_message", args: { channel_id: "D1", message: "hi" }, profile: "executor" });
const sent = await write(p, { key: "reply-42", profile: "executor" }); // { sent: true, key, ref, value } or { replayed: true, key, ref }
```

A plan is plain JSON and can be saved, approved and sent later. `write()` plans its request again and sends it only if the hash still matches, under the profile the sender names (or the instance's), never the one written in the plan. The whole flow is in [Writes: plan, approve, send](writes.md).

## Batch

`batch()` takes any iterable or async iterable of calls, each with an optional `id`, and gives results as they finish (in input order with `{ ordered: true }`):

```ts
import { batch } from "@obrier/plugboard";

for await (const r of batch([{ id: "today", connector: "google-calendar", tool: "list_events", args: { calendarId: "primary" } }])) {
  if (r.ok) console.log(r.id, r.value);
  else console.warn(r.id, r.error.code, r.error.hints);
}
```

- Each result is `{ id, ok: true, value, raw, via }` or `{ id, ok: false, error }`.
- Options are `concurrency`, `perConnector`, `ordered` and `budgetMs`.
- Leaving the loop cancels the lines still running.

## Errors

Errors are `PlugboardError`, with the CLI's `code`, `hints` and `exitCode`. The codes are the CLI's [exit codes](../reference/commands.md#exit-codes).

## Sessions

The module functions share one session that takes connectors on as they're called and never keeps your program from exiting. `createPlugboard({ policy, profile, transport })` makes another instance; `close()` ends a session early.
