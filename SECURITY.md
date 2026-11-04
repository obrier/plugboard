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
- **Never handles your credentials.** Plugboard asks Claude Code to make each call; your connector tokens stay with Claude Code and claude.ai. The `claude` child process runs with a scrubbed environment: another Claude Code session's identifiers and messaging socket aren't passed on. Its stderr is discarded rather than logged.
- **Reads by default.** A tool counts as a read only if its connector marks it `readOnlyHint` and not `destructiveHint`. Everything else is a write, including tools with no annotations. Wildcards in a profile only ever match read tools.
- **Writes only exact, approved payloads.** A write needs a write profile, `--write`, a `--write-key`, and the hash that `--plan` printed for exactly that payload. Writes are never retried. A write that timed out blocks its key until someone checks the destination and resolves it.
- **Refuses writes from agent sessions.** When `CLAUDECODE` is set (inside Claude Code), writes are refused unless a profile sets `allow_in_agent = true`.
- **Audits every write.** It logs to `~/.local/state/plugboard/audit.jsonl` (mode `0600`) before and after each call, with payload and result hashes, never the content.
- **Proves zero cost.** Each run checks that the session spent $0 and 0 tokens, and exits 10 if not.

**What to keep in mind:**
- **Tool output is untrusted data.** Messages, emails and documents can contain text written to manipulate an AI. Don't let an agent feed one tool's output into another call's arguments, or into a write, without a human in between. The plan → hash → write flow exists for this.
- **The cache holds tool schemas, not tool results.** Results only go where you send them: stdout, your files, your agent's context.
- **Plugboard drives an internal Claude Code interface.** An update can change its behaviour. `plugboard doctor` checks the protocol and the cost guard; run it as a gate in automation.
