# plugboard

**Your claude.ai connectors as shell commands.** Slack, Gmail, Google Calendar, Drive, Datadog, Sentry, Figma: every connector you've already connected in claude.ai becomes a command you can script, pipe and run in batches. It reuses your Claude Code login and spends **zero model tokens**.

```console
$ plugboard cal list-events --calendar-id primary --start-time today --end-time tomorrow --items events --select summary,start.dateTime
$ plugboard slack search-public --keywords deploy --after -1d --out md
$ plugboard gmail search-threads --query "from:billing newer_than:7d" --out json | jq '.threads | length'
```

> [!WARNING]
> plugboard drives an **internal, undocumented interface** of Claude Code. It can break with any Claude Code update. It is not affiliated with or endorsed by Anthropic, and using connectors this way may not be covered by their terms. See [Caveats](#caveats).

## Why

Connectors give Claude access to your tools, but only from inside a chat or an agent. Scripts that only need data (a morning digest, a cron job, a dashboard) shouldn't pay for a model, or wait for one, to make an API call. plugboard calls the same connector tools directly from your shell, with:

- **Flags generated from each tool's schema:** `--help` on any tool shows its parameters, types, enums and required fields.
- **Safe defaults:** read-only unless a policy profile says otherwise, and writes have to name their exact payload first.
- **Output for humans, scripts and agents:** plain text, JSON, markdown, or compact [AXI](https://github.com/kunchenguid/axi)/TOON output with `--axi`.
- **Batching:** many calls over one connection, with backoff on rate limits.
- **A preflight check:** `plugboard doctor` tells your scripts whether the bridge still works after a Claude Code update.

## Requirements

- macOS or Linux.
- [Claude Code](https://code.claude.com), installed and logged in with a claude.ai account (`claude /login`).
- The connectors you want, connected in claude.ai → Settings → Connectors.

## Install

```bash
brew install aanduque/tap/plugboard
```

Then capture your connectors' tool schemas and check that everything works:

```bash
plugboard refresh
plugboard doctor
```

## Quick start

```bash
plugboard                          # your connectors and their status
plugboard slack                    # a connector's tools, with class read | write
plugboard find "search logs"       # search every tool by name and description
plugboard slack read-thread --help # flags generated from the tool's schema
plugboard slack read-thread --channel-id C0123 --message-ts 1762243803.1234
plugboard usage                    # rank tools by how often your Claude Code sessions call them
```

Tool names come in a short form: `slack_search_public` becomes `slack search-public`. The original name works too. Short connector aliases are built in: `cal`, `gcal`, `drive`, `docs`, `sheets`, `slides`, `dd`, `jira`.

## Passing arguments

Every tool parameter is a flag, generated from the tool's JSON Schema:

| Schema | Flag |
|---|---|
| string, number, integer | `--name value` (numbers are checked) |
| boolean | `--name` / `--no-name` |
| enum | `--name a`, checked against the allowed values |
| array of strings or numbers | repeat it: `--name a --name b`, or `--name '["a","b"]'` |
| object, or anything complex | `--name '{"k":1}'`, `--name @file.json`, or dot-flags: `--name.k 1` |
| the whole argument object | `--json '{…}'` or `--arg-file args.json` (`-` for stdin) |

Arguments merge in this order, later winning: `--arg-file`, then `--json`, then individual flags, then dot-flags. The result is validated against the tool's schema before anything is sent.

Time parameters you list in the policy file accept `today`, `yesterday`, `-2d`, `+7d`, `2026-11-03`, or `monday 9am`, converted to the format the tool expects.

## Output

| Flag | Prints |
|---|---|
| *(default)* | Plain text: `key: value` lines and aligned tables. Tool results as pretty JSON, or markdown when the result is text |
| `--out json` | Compact JSON, never truncated: for scripts |
| `--out md` | The text fields of the result as markdown (Slack search results, for example) |
| `--out raw` | The connector's response exactly as received |
| `--axi` | [AXI](https://github.com/kunchenguid/axi) output for agents: TOON, `help[]` hints, structured errors. `PLUGBOARD_AXI=1` sets it for a whole session |

Shape results without `jq`:
- `--select a,b.c` keeps only those fields.
- `--where 'n > 1 and user == "ana"'` filters a list ([filtrex](https://github.com/joewalnes/filtrex) syntax).
- `--items <field>` says which list to shape when a result has more than one.

## Batch

One connection, many calls, JSONL in and JSONL out:

```bash
plugboard batch --as reader --concurrency 4 < calls.jsonl > results.jsonl
```

```json
{"id":"mentions","connector":"slack","tool":"search-public","args":{"keywords":["deploy"],"after":"-1d"}}
{"id":"today","connector":"cal","tool":"list-events","args":{"calendarId":"primary","startTime":"today","endTime":"tomorrow"},"items":"events","select":"summary"}
```

Each output line is `{"id","ok":true,"ms","result"}` or `{"id","ok":false,"error":{"code","message","retryable"}}`.
- **Failures stay local:** a bad line fails on its own, without stopping the batch.
- **Rate limits:** a 429 backs off and drops that connector to one call at a time.
- **Auth failures:** one auth failure fails the rest of that connector's lines at once.
- **Reads only:** batch never runs write tools.

## Safety model

plugboard is read-only unless you configure otherwise.

- **Classification:** a tool counts as a read only if its connector marks it `readOnlyHint` and not `destructiveHint`. Everything else is a write, including tools with no annotations at all.
- **Profiles:** these live in `~/.config/plugboard/policy.toml`. Each one allows and denies tools with `connector:tool` patterns. Wildcards only ever match read tools; a write tool must be listed by its exact name, in a profile with `mode = "write"`.
- **A write needs four things:**
  1. a write profile (`--as`);
  2. `--write`;
  3. an idempotency key (`--write-key`);
  4. the payload hash that `--plan` printed for exactly that payload (`--expect-hash`).
- **Approve first, then send:** another process can approve a payload by its hash, and plugboard sends it only if the bytes still match.
- **Never retried, always logged:** writes are never retried. Each one is logged before and after the call, by hash, to `~/.local/state/plugboard/audit.jsonl`. A write that timed out blocks its key until you check the destination and run `plugboard audit resolve <key> --sent|--not-sent`.
- **No writes from agent sessions:** plugboard refuses writes from inside a Claude Code session unless a profile opts in with `allow_in_agent = true`.
- **Cost guard:** every run ends by checking that the session cost is still $0 with 0 tokens. Anything else exits with code 10.

```toml
# ~/.config/plugboard/policy.toml (full example: policy.example.toml)
[profiles.reader]
mode = "read"
allow = ["slack:slack_search_*", "slack:slack_read_*", "google-calendar:list_events", "gmail:search_threads"]

[profiles.sender]
mode = "write"
allow = ["slack:slack_send_message"]
```

```bash
plugboard slack send-message --arg-file reply.json --as sender --plan --out json      # prints the hash
plugboard slack send-message --arg-file reply.json --as sender --write --write-key reply-42 --expect-hash sha256:…
```

This is a guard rail against bugs and confused automation, not a sandbox: any program running as you can run `claude` itself.

## Commands

| Command | Does |
|---|---|
| `plugboard` | Your connectors and their status (no network) |
| `plugboard <connector> [--all]` | List tools, most-used first after `plugboard usage` (top 20; `--all` for every tool) |
| `plugboard <connector> <tool> […]` | Call a tool; `--help` shows its flags |
| `plugboard find <words>` | Search all tools |
| `plugboard batch` | JSONL calls on stdin |
| `plugboard doctor [--as p] [--schemas]` | Check login, protocol, connectors, schema drift, zero cost |
| `plugboard refresh [connector…]` | Recapture tool schemas |
| `plugboard usage [--days 30]` | Rank tools by your Claude Code sessions' calls |
| `plugboard policy [--as p] [connector]` | What a profile may call |
| `plugboard audit [--unresolved]` | The write log; `audit resolve <key> --sent\|--not-sent` |
| `plugboard setup hooks [--project] [--remove]` | Show plugboard's home view at the start of Claude Code, Codex and OpenCode sessions |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Error |
| 2 | Usage error, or unknown tool or connector |
| 3 | Refused by policy |
| 4 | Connector needs authentication |
| 5 | Rate limited |
| 6 | A write's outcome is unknown |
| 7 | Partial: some batch lines failed, or doctor found connectors down |
| 10 | Bridge broken, or the cost guard tripped |

`doctor` is meant as a preflight gate: `plugboard doctor --as reader || exit`.

### Files and environment

| Path | Holds | Override |
|---|---|---|
| `~/.config/plugboard/policy.toml` | Profiles, aliases, time transforms | `PLUGBOARD_POLICY` |
| `~/.cache/plugboard/` | Tool schemas per connector, usage counts | `PLUGBOARD_CACHE` |
| `~/.local/state/plugboard/` | Audit log, last doctor result | `PLUGBOARD_STATE` |
| `~/.local/bin/claude` | The Claude Code binary to drive | `PLUGBOARD_CLAUDE`, or `claude_path` in the policy |

`PLUGBOARD_PROFILE` sets the default profile, and `PLUGBOARD_AXI=1` the AXI output.

## How it works

Claude Code has a JSON control protocol (`--input-format stream-json`) that its SDKs use. Two of its requests are `mcp_status`, which lists connectors and their tools, and `mcp_call`, which calls one. plugboard starts `claude` with no tools and no model use, and talks to it directly.

Tool argument schemas aren't part of `mcp_status`. `plugboard refresh` captures them by pointing a second, short-lived `claude` at a local endpoint that reads the tool definitions from the request Claude Code prepares, then rejects it. Nothing is forwarded to a model. Each run then checks that the session cost is still $0.

## Caveats

- **Unsupported interface.** The control protocol is internal to Claude Code and can change without notice. When that happens, `plugboard doctor` exits 10. You can point `claude_path` at a previous version, kept under `~/.local/share/claude/versions/`, until plugboard catches up.
- **Terms.** It works technically; that doesn't mean Anthropic, or your connectors' providers, approve of using connectors this way. Check the terms that apply to you, especially before automating writes.
- **Upstream schemas change.** Connector tools gain and lose parameters often. Run `plugboard refresh` regularly; `plugboard doctor --schemas` reports drift.
- **Tool output is data.** Messages and documents can contain text written to steer an AI. Never feed tool output into another call's arguments, or into an agent that can write, without a human in between.

## Development

```bash
bun install
bun test                             # offline: unit tests and CLI tests against a fake claude
LIVE=1 bun test test/live.test.ts    # read-only calls against your real connectors
bun run typecheck && bun run link    # builds dist/plugboard and links it on your PATH
```

Releases: `scripts/release.sh` builds the standalone binaries for macOS and Linux and renders the Homebrew formula for [aanduque/homebrew-tap](https://github.com/aanduque/homebrew-tap). plugboard is distributed only through Homebrew.

## License

[MIT](LICENSE)
