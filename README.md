# Plugboard

**Auth once. Plug into any agent.**

[![CI](https://img.shields.io/github/actions/workflow/status/obrier/plugboard/ci.yml?branch=main&label=ci)](https://github.com/obrier/plugboard/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/obrier/plugboard?sort=semver)](https://github.com/obrier/plugboard/releases) [![Homebrew](https://img.shields.io/badge/brew-obrier%2Ftap%2Fplugboard-orange)](https://github.com/obrier/homebrew-tap) [![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20WSL2-lightgrey)](docs/reference/files.md#platforms) [![License: MIT](https://img.shields.io/github/license/obrier/plugboard)](LICENSE)

Your claude.ai connectors (Slack, Gmail, Calendar, Drive, Datadog, Sentry, Figma, your org's custom ones) as shell commands. Any agent that can run a shell gets them: Codex, Gemini CLI, pi, Hermes, OpenCode, or a cron job. It reuses the Claude Code login you already have. No new OAuth, no API keys, no tokens held by a third party, and zero model tokens per call. Read-only by default; writes need a plan, a hash and a human.

```console
$ plugboard                              # connectors and their status, no network
$ plugboard find "search logs"           # every tool, by name and description
$ plugboard slack read-thread --help     # flags generated from the tool's schema
$ plugboard slack search-public --keywords deploy --out md
$ plugboard datadog search-datadog-logs --help
```

Same commands, same result, from any harness or script. When Anthropic adds a connector to claude.ai, `plugboard refresh` makes it a command too.

> [!WARNING]
> Plugboard drives an **internal, undocumented interface** of Claude Code. It can break with any Claude Code update (`plugboard doctor` tells you when). It is not affiliated with or endorsed by Anthropic, and using connectors this way may not be covered by their terms. See [Caveats](docs/concepts/how-it-works.md#caveats).

## Why

Connectors give Claude access to your tools, but only inside a Claude chat or a Claude Code session. Every other agent re-authenticates each service in its own MCP client, stores its own tokens, and pays schema tokens up front. Scripts can't use connectors at all.

Plugboard fixes four things:

1. **One login, every agent.** Connect a service once in claude.ai. Every harness and script on the machine can call it.
2. **Safe by default.** Reads only, unless a policy profile says otherwise. A write needs `--plan`, which prints a payload hash, then `--write --expect-hash` with that exact hash and an idempotency key. Writes are never retried, always audited, and refused from inside agent sessions unless a profile opts in. No call can reach a model: it costs $0 and 0 tokens.
3. **Deterministic.** The same command makes the same call. No model in the loop: cron, CI and batch pipelines just work.
4. **New connectors, no wrappers.** Anything that appears in claude.ai is a command after `plugboard refresh`. No community MCP server to wait for, no CLI to write.

## Requirements

- macOS, Linux, or Windows through WSL2 (x64 or arm64). See [Platforms](docs/reference/files.md#platforms).
- [Claude Code](https://code.claude.com), installed and logged in with a claude.ai account (`claude /login`).
- The connectors you want, connected in claude.ai → Settings → Connectors.

## Install

```bash
brew install obrier/tap/plugboard
```

Homebrew 7 loads formulae from third-party taps only once they're trusted, and installing by the full name, as above, trusts this one formula. If you installed Plugboard with an earlier Homebrew and `brew upgrade` now skips it, trust it once ([Tap Trust](https://docs.brew.sh/Tap-Trust)):

```bash
brew trust --formula obrier/tap/plugboard
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

Tool names come in a short form: `slack_search_public` becomes `slack search-public`. The original name works too. Short connector aliases are built in: `cal`, `gcal`, `drive`. Add your own under `[aliases]` in the policy.

## Documentation

- [Getting started](docs/getting-started.md): install, your first call, and checking it all works.
- [Use it from any agent](docs/harness-guides.md): the instruction block for Codex, Gemini CLI, pi, Hermes, OpenCode, Claude Code, sandboxes and cron.
- [Writes: plan, approve, send](docs/guides/writes.md): how a write gets from an idea to a sent message, safely.
- [Batch](docs/guides/batch.md): many calls on one connection, JSONL in and out.
- [From code](docs/guides/library.md): the same calls from TypeScript with `@obrier/plugboard`.
- [How it works](docs/concepts/how-it-works.md), with its caveats.
- [Policy and safety](docs/concepts/safety.md): profiles, writes, the audit log and the cost guard.
- [Compared with alternatives](docs/concepts/comparison.md): MCPorter, Composio and native harness MCP.
- [Commands](docs/reference/commands.md): every command, passing arguments, output and exit codes.
- [Files and environment](docs/reference/files.md): paths, variables, transports and platforms.

## Development

```bash
bun install
bun test                             # offline: unit tests and CLI tests against a fake claude
plugboard refresh && LIVE=1 bun test test/live.test.ts  # read-only calls against your connected connectors, then doctor
bun run typecheck && bun run link    # builds dist/plugboard and links it on your PATH
```

Releases: `scripts/release.sh` builds the standalone binaries for macOS and Linux and renders the Homebrew formula for [obrier/homebrew-tap](https://github.com/obrier/homebrew-tap). The CLI ships through Homebrew and the library through npm; see [docs/RELEASING.md](docs/RELEASING.md).

## License

[MIT](LICENSE)
