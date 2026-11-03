# plugboard

claude.ai connector tools (Slack, Gmail, Calendar, Drive, Datadog, Sentry, …) as shell commands, at zero model tokens. An AXI CLI that drives Claude Code's internal `stream-json` control protocol (`mcp_status`, `mcp_call`).

```bash
plugboard                                    # home: connectors, profile, bridge status (no spawn)
plugboard slack                              # list tools with class read | write
plugboard slack search-public --help         # flags generated from the tool's JSON Schema
plugboard cal list-events --calendar-id primary --start-time today --end-time tomorrow --items events --select summary,start.dateTime
plugboard batch --as gather < calls.jsonl > results.jsonl
plugboard doctor --as gather                 # preflight gate: exit 0 | 7 (some blind) | 10 (bridge broken)
plugboard refresh                            # recapture schemas into ~/.cache/plugboard (~6 s)
```

## Output

- **Default: plain output.** Commands print `key: value` lines and aligned tables. Tool results print as pretty JSON, or as markdown when the result is text (Slack). Errors go to stderr as `error: … (CODE)` with `hint:` lines.
- **`--axi`** (anywhere in the command, or `PLUGBOARD_AXI=1`) switches to AXI output for agents: TOON on stdout, `help[]` hints, and errors as `error:`/`code:`/`help[]` on stdout.
- **Fixed formats:** `--out json|md|raw` gives the same output in both modes. `batch` always writes JSONL.

## Safety

- **Reads by default.** A tool is read only if it carries `readOnlyHint` and not `destructiveHint`. Anything else is a write, including tools with no annotations.
- **Profiles** live in `policy.toml`: `$PLUGBOARD_POLICY`, else `~/.config/plugboard/policy.toml`; see `policy.example.toml`.
  - Globs only ever grant read tools.
  - A write tool must be named exactly in a `mode = "write"` profile.
  - Deny beats allow.
- **A write needs all of the following:**
  - `--as <write profile>` and `--write`;
  - a `--write-key`;
  - the `--expect-hash` that `--plan` prints for that exact payload.
- **How writes are handled:**
  - Writes skip the time transforms.
  - They are never retried, and they are refused when `CLAUDECODE` is set (inside Claude Code), unless the profile sets `allow_in_agent = true`.
  - Every write is logged to `~/.local/state/plugboard/audit.jsonl` before and after the call, with the payload hash only. A timeout leaves the key blocked (exit 6) until `audit resolve <key> --sent|--not-sent`.
- **Cost guard:** every run ends with `get_session_cost`. Anything but `$0.0000` / 0 tokens exits 10.
- **The child `claude` runs with a scrubbed environment.** Per-session `CLAUDE_CODE_*` and `CLAUDECODE` are dropped; login still works (checked 3 Nov).

This is a guard rail against bugs and confused callers, not a sandbox: any process running as you can run `claude` itself.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | OK |
| 1 | Error |
| 2 | Usage / not found |
| 3 | Policy |
| 4 | Auth |
| 5 | Rate limited |
| 6 | Write outcome unknown |
| 7 | Partial (batch lines failed; doctor found blind connectors) |
| 10 | Bridge broken / cost guard |

## Development

```bash
bun install && bun test          # unit + CLI tests against test/fixtures/fake-claude.ts (no network)
LIVE=1 bun test test/live.test.ts  # read-only live smoke test
bun run typecheck && bun run link
```

`src/bridge/client.ts` and `src/bridge/capture.ts`, local changes:
- `waitForServers(names)` waits only for the connectors a call needs;
- `childEnv()` gives the child a scrubbed environment;
- the `listTools` overloads take `servers`.

`test/bridge-client.test.ts` and its fixture are the bridge's own tests, still passing.

**Internal, unsupported interface.** Passing tests show it works technically, not that Anthropic approves connector-only use. After a Claude Code update breaks it, `doctor` exits 10, and `claude_path` in `policy.toml` can point at a version under `~/.local/share/claude/versions/`.
