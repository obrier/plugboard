# Policy and safety

Plugboard is read-only unless you configure otherwise.

## Reads and writes

A tool counts as a read only if its connector marks it `readOnlyHint` and not `destructiveHint`. Everything else is a write, including tools with no annotations at all. `plugboard <connector>` shows each tool's class.

## Profiles

Profiles live in `~/.config/plugboard/policy.toml`. Each one allows and denies tools with `connector:tool` patterns. Wildcards only ever match read tools; a write tool must be listed by its exact name, in a profile with `mode = "write"`.

```toml
# ~/.config/plugboard/policy.toml (full example: policy.example.toml)
[profiles.reader]
mode = "read"
allow = ["slack:slack_search_*", "slack:slack_read_*", "google-calendar:list_events", "gmail:search_threads"]

[profiles.executor]
mode = "write"
allow = ["slack:slack_send_message"]
```

Pick a profile with `--as`, or set a default with `PLUGBOARD_PROFILE`. `plugboard policy --as reader` shows what a profile may call. The full example is [policy.example.toml](https://github.com/obrier/plugboard/blob/main/policy.example.toml).

## Writes

A write needs four things:
1. a write profile (`--as`);
2. `--write`;
3. an idempotency key (`--write-key`);
4. the payload hash that `--plan` printed for exactly that payload (`--expect-hash`).

A tool its connector marks `destructiveHint` also needs `allow_destructive = true` in the profile.

Another process can approve a payload by its hash, and Plugboard sends it only if the bytes still match. Writes are never retried. Each one is logged before and after the call, by hash, to `~/.local/state/plugboard/audit.jsonl`. A write that timed out blocks its key until you check the destination and run `plugboard audit resolve <key> --sent|--not-sent`.

Plugboard refuses writes from inside a Claude Code session unless a profile opts in with `allow_in_agent = true`.

The steps, with examples, are in [Writes: plan, approve, send](../guides/writes.md).

## Cost guard

A call made direct (see [How it works](how-it-works.md)) only reaches the connector proxy, which serves connector tools and no model. A run that starts Claude Code ends by checking that its session cost is still $0 with 0 tokens. Anything else exits with code 10.

## What it is not

This is a guard rail against bugs and confused automation, not a sandbox: any program running as you can run `claude` itself. The full trust model, and how to report a vulnerability privately, are in [SECURITY.md](https://github.com/obrier/plugboard/blob/main/SECURITY.md).
