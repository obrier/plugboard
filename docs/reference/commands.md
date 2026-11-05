# Commands

| Command | Does |
|---|---|
| `plugboard` | Your connectors and their status (no network) |
| `plugboard <connector> [--all]` | Its tools; after `plugboard usage`, most-used first and the top 20 (`--all` for every tool) |
| `plugboard <connector> <tool> […]` | Call a tool; `--help` shows its flags |
| `plugboard find <words>` | Search all tools by name and description |
| `plugboard batch` | JSONL calls on stdin, a result per line on stdout; see [Batch](../guides/batch.md) |
| `plugboard doctor [--as p] [--schemas]` | Check login, connectors, schema drift and zero cost |
| `plugboard refresh [connector…]` | Recapture tool schemas |
| `plugboard usage [--days 30]` | Rank tools by how often your Claude Code sessions call them |
| `plugboard policy [--as p] [connector]` | What a profile may call |
| `plugboard audit [--unresolved]` | The write log; `audit resolve <key> --sent\|--not-sent` |
| `plugboard setup hooks [--project] [--remove]` | Show Plugboard at the start of Claude Code, Codex and OpenCode sessions |

## Passing arguments

Every tool parameter is a flag, generated from the tool's JSON Schema:

| Schema | Flag |
|---|---|
| string, number, integer | `--name value` (numbers are checked) |
| boolean | `--name` / `--no-name` |
| enum | `--name a`, checked against the allowed values |
| array of strings or numbers | repeat it: `--name a --name b`, or `--name '["a","b"]'` |
| object | `--name '{"k":1}'`, `--name @file.json`, or `--name.k 1` |
| the whole argument object | `--json '{…}'` or `--arg-file args.json` (`-` for stdin) |

Arguments merge in this order, later winning: `--arg-file`, then `--json`, then individual flags, then dot-flags. The result is validated against the tool's schema before anything is sent.

Time parameters accept `today`, `yesterday`, `-2d`, `+7d`, `2026-11-03`, or `monday 9am`, converted to the format the tool expects; `--help` marks them. That works for parameters whose schema declares a date format, for the built-in rules (Google Calendar's `list_events` and `suggest_time`), and for the ones you add to `~/.config/plugboard/transforms.toml` ([example](https://github.com/obrier/plugboard/blob/main/transforms.example.toml)). To find and test your own connectors' time parameters, give an agent the [plugboard-transforms](https://github.com/obrier/plugboard/blob/main/skills/plugboard-transforms/SKILL.md) skill: it writes only that file, never the policy.

## Output

| Flag | Prints |
|---|---|
| *(default)* | Plain text: `key: value` lines and aligned tables. Tool results as pretty JSON, or markdown when the result is text |
| `--out json` | Compact JSON, never truncated: for scripts |
| `--out md` | The result's text fields as markdown |
| `--out raw` | The connector's response exactly as received |
| `--axi` | [AXI](https://github.com/kunchenguid/axi) output for agents: TOON, `help[]` hints, structured errors. On by default inside Claude Code; `PLUGBOARD_AXI=1` sets it for a whole session elsewhere, `PLUGBOARD_AXI=0` turns it off |

Shape results without `jq`:
- `--select a,b.c` keeps only those fields.
- `--where 'n > 1 and user == "ana"'` filters a list ([filtrex](https://github.com/joewalnes/filtrex) syntax).
- `--items <field>` says which list to shape when a result has more than one.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Error |
| 2 | Usage error, or unknown tool or connector |
| 3 | Refused by policy |
| 4 | Connector needs authentication in claude.ai |
| 5 | Rate limited |
| 6 | A write's outcome is unknown |
| 7 | Partial: some batch lines failed, or doctor found connectors down |
| 10 | Unreachable (`UNREACHABLE`: neither the connector proxy nor Claude Code could reach your connectors, as in a sandbox), or the cost guard tripped (`COST_GUARD`) |

`doctor` is meant as a preflight gate: `plugboard doctor --as reader || exit`.
