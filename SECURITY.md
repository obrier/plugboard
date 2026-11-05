# Security

Plugboard can read, and with a write profile also write to, everything your claude.ai connectors reach: Slack, mail, calendars, documents, monitoring. This page says what it protects against, what it doesn't, and how to report a problem.

## Reporting a vulnerability

Please **don't open a public issue.** Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include:
- the Plugboard version (`plugboard --version`) and the Claude Code version (`claude --version`);
- your platform;
- what an attacker can do, and the steps to reproduce it.

You'll get an acknowledgement within a week. A fix or mitigation follows as soon as it's understood, and you'll be credited unless you'd rather not be.

**In scope:**
- ways to make Plugboard write without `--write`, a write profile, a matching `--expect-hash` and a `--write-key`;
- ways around the `CLAUDECODE` refusal, the deny list, or the rule that wildcards never grant write tools;
- credentials or tool output leaking into logs, the audit log or the cache;
- a cost guard that misses model usage.

**Out of scope:**
- bugs in Claude Code or in the connectors themselves; report those to Anthropic or the connector's vendor;
- anything that requires already running code as your user (see below).

## Trust model

**Plugboard is a guard rail, not a sandbox.** Any program running as your user can start `claude` and call your connectors directly, with or without Plugboard. The policy layer protects against bugs, mistakes and confused automation, not against hostile code already on your machine.

**What it does:**
- **Uses Claude Code's claude.ai login, never stores it.** To call a connector, Plugboard reads the login Claude Code keeps (the macOS keychain item `Claude Code-credentials`, or `~/.claude/.credentials.json` elsewhere) for that one run, in memory, and sends it only to Anthropic's connector proxy, `https://mcp-proxy.anthropic.com`. It never writes, logs or renews it; your connectors' own tokens (Google's, Slack's) stay with claude.ai. The transport `claude-code` (`PLUGBOARD_TRANSPORT=claude-code`, or `transport` in policy.toml) turns this off, and Plugboard then asks Claude Code to make each call instead. That `claude` child process runs with a scrubbed environment: another Claude Code session's identifiers and messaging socket aren't passed on. Its stderr is discarded rather than logged.
- **Reads by default.** A tool counts as a read only if its connector marks it `readOnlyHint` and not `destructiveHint`. Everything else is a write, including tools with no annotations. Wildcards in a profile only ever match read tools.
- **Writes only exact, approved payloads.** A write needs a write profile, `--write`, a `--write-key`, and the hash that `--plan` printed for exactly that payload. A tool's own `idempotency_key`, which Plugboard fills from the write key, is sent but not hashed: the hash names the content, and the key is chosen when the write is sent. An approval names content, not a single send: the same hash can be sent once under each key, so approve a hash only as often as you'd send it. Writes are never retried. A write that timed out blocks its key until someone checks the destination and resolves it.
- **Refuses writes from agent sessions.** When `CLAUDECODE` is set (inside Claude Code), writes are refused unless a profile sets `allow_in_agent = true`.
- **Audits every write.** It logs to `~/.local/state/plugboard/audit.jsonl` (mode `0600`) before and after each call, with payload and result hashes, never the content.
- **Proves zero cost.** A call made direct talks to the connector proxy only, which serves connector tools and no model. When Claude Code runs, each run checks that its session spent $0 and 0 tokens, and exits 10 if not.

**What to keep in mind:**
- **Tool output is untrusted data.** Messages, emails and documents can contain text written to manipulate an AI. Don't let an agent feed one tool's output into another call's arguments, or into a write, without a human in between. The plan → hash → write flow exists for this.
- **The cache holds tool schemas, not tool results.** Results go where you send them: stdout, your files, your agent's context. One exception: `batch --axi`, and an AXI call whose output is cut, write full results under `~/.local/state/plugboard/results/` (folders `0700`, files `0600`; on Windows, `%LOCALAPPDATA%\plugboard\state\results`, private through that folder's per-user access). That can include mail, chat and a write tool's reply; each run removes the runs older than a day.
- **Plugboard drives internal interfaces:** Claude Code's control protocol, and the connector proxy its claude.ai connectors go through. An update can change either. A direct call the proxy refuses (400, 401, 403, 404, or no connection) is made through Claude Code instead. `plugboard doctor` checks the protocol, the cost guard and each required connector's read through both paths; run it as a gate in automation.
