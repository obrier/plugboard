# Getting started

Plugboard reuses the Claude Code login you already have. There's no new OAuth and no API key: connect a service once in claude.ai, and every script and agent on your machine can call it.

## What you need

- macOS, Linux, or Windows through WSL2 (x64 or arm64).
- [Claude Code](https://code.claude.com), installed and logged in with a claude.ai account (`claude /login`).
- The connectors you want, connected in claude.ai → **Settings → Connectors**.

## Install

```bash
brew install obrier/tap/plugboard
```

Installing by the full name trusts this one formula, which Homebrew 7 asks of third-party taps. If an earlier install no longer upgrades, trust it once:

```bash
brew trust --formula obrier/tap/plugboard
```

## Capture your connectors

Plugboard reads each connector's tools and their argument schemas once, into a local cache. Then it checks that calls work and cost nothing:

```bash
plugboard refresh   # about 4 seconds
plugboard doctor    # exit 0: ready
```

`doctor` checks your login, each connector, and that a call reaches no model. It exits 0 when all is well, 7 when some connectors are down, and 10 when Plugboard can't reach your connectors at all.

## Your first call

```console
$ plugboard
claude: 2.1.318 (tested)
profile: default (read)
policy: built-in default (read only, all read tools)
connectors:
  ID               STATUS      READ  WRITE
  gmail            connected   6     24
  google-calendar  connected   5     4
  google-drive     connected   6     5
  slack            connected   9     6
hint: Run `plugboard <connector>` to list its tools

$ plugboard find "search messages"
$ plugboard slack search-public --help
$ plugboard slack search-public --query deploy --out md
```

Every tool parameter is a flag, generated from the tool's schema, and checked before anything is sent. Tool names come in a short form: `slack_search_public` becomes `slack search-public`.

> [!TIP]
> **Reads only, by default.** Every call above is a read. Plugboard refuses writes until a policy profile allows them, and even then a write needs a plan and its hash. See [Writes: plan, approve, send](guides/writes.md).

## Next

- Shape what comes back with `--select`, `--where` and `--out`: see [Commands](reference/commands.md).
- Give the tools to your agent: [Use it from any agent](harness-guides.md).
- Call the same tools from code: [From code](guides/library.md).
