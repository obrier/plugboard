# Commands

| Command | Does |
|---|---|
| `plugboard` | Your connectors and their status (no network) |
| `plugboard <connector> [--all]` | Its tools, most-used first (top 20; `--all` for every tool) |
| `plugboard <connector> <tool> […]` | Call a tool; `--help` shows its flags |
| `plugboard find <words>` | Search all tools by name and description |
| `plugboard batch` | JSONL calls on stdin, a result per line on stdout |
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

Later sources win: `--arg-file`, then `--json`, then flags, then dot-flags. Time parameters take `today`, `-2d`, `2026-11-03` or `monday 9am`.

## Output

| Flag | Prints |
|---|---|
| *(default)* | Plain text, with tool results as JSON, or markdown when the result is text |
| `--out json` | Compact JSON, never truncated |
| `--out md` | The result's text fields as markdown |
| `--out raw` | The connector's response exactly as received |
| `--axi` | Output for agents: TOON, `help[]` hints and structured errors |

Shape a result without `jq`: `--select a,b.c` keeps fields, `--where 'n > 1'` filters a list, and `--items <field>` names the list to shape.

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
| 10 | Unreachable, or a model was reached (cost guard) |
