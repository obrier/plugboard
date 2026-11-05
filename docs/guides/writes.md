# Writes: plan, approve, send

Plugboard is read-only unless you set it up otherwise. A write, such as sending a Slack message, goes through three steps, so that what a person approved is exactly what gets sent, once.

1. **Plan** it: Plugboard prints the payload it would send and a hash of it.
2. **Approve** that hash: you, or a process acting for you, decide this payload may go.
3. **Send** it, naming the hash and a key: Plugboard sends only if the payload still matches, and never twice under one key.

## 1. Allow the write in a profile

Writes need a profile with `mode = "write"` that names the tool exactly. Wildcards only ever match read tools.

```toml
# ~/.config/plugboard/policy.toml
[profiles.executor]
mode = "write"
allow = ["slack:slack_send_message"]
```

## 2. Plan it

```console
$ plugboard slack send-message --arg-file reply.json --as executor --plan --out json
{
  "connector": "slack",
  "tool": "slack_send_message",
  "class": "write",
  "destructive": false,
  "profile": "executor",
  "decision": "allowed",
  "hash": "sha256:9f2c…",
  "payload": { "channel_id": "D1", "message": "Shipped 🎉" }
}
```

The hash names the content. If anything in the payload changes, the hash changes, and an approval for the old one no longer applies.

## 3. Send it

```bash
plugboard slack send-message --arg-file reply.json --as executor \
  --write --write-key reply-42 --expect-hash sha256:9f2c…
```

- **The key** (`--write-key`) names this send. Run the same command again and Plugboard replays the first result instead of sending a second message.
- **The hash** (`--expect-hash`) must match the payload as planned again now. A file edited since the plan is refused.

> [!WARNING]
> **A write that times out.** Plugboard never retries a write. If one times out, its outcome is unknown: check the destination, then record what happened with `plugboard audit resolve reply-42 --sent` (or `--not-sent`). Until then, that key refuses to send.

## What else guards a write

| Guard | What it does |
|---|---|
| Audit log | Every write is logged before and after the call, by hash, to `~/.local/state/plugboard/audit.jsonl` |
| Agent sessions | Writes are refused inside a Claude Code session unless the profile sets `allow_in_agent = true` |
| Cost guard | A call that reached a model, even one that failed, stops with exit 10 |

This is a guard rail against bugs and confused automation, not a sandbox: any program running as you can run `claude` itself. The full trust model is in [SECURITY.md](https://github.com/obrier/plugboard/blob/main/SECURITY.md).

## From code

The library takes the same three steps. A plan is plain JSON, so it can be saved, shown to a person, and sent later:

```ts
import { plan, write } from "@obrier/plugboard";

const p = plan({ connector: "slack", tool: "send_message", args: { channel_id: "D1", message: "Shipped 🎉" }, profile: "executor" });
// …a person approves p.hash…
const sent = await write(p, { key: "reply-42", profile: "executor" });
```
