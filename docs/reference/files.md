# Files and environment

## Files

| Path | Holds | Override |
|---|---|---|
| `~/.config/plugboard/policy.toml` | Profiles, aliases | `PLUGBOARD_POLICY` |
| `~/.config/plugboard/transforms.toml` | Time transforms only; nothing else in it is read | `PLUGBOARD_TRANSFORMS` |
| `~/.cache/plugboard/` | Tool schemas per connector, usage counts | `PLUGBOARD_CACHE` |
| `~/.local/state/plugboard/` | Audit log, last doctor result, `results/` (full results from `batch --axi` and cut AXI calls, kept a day) | `PLUGBOARD_STATE` |
| `~/.local/bin/claude` | The Claude Code binary to drive | `PLUGBOARD_CLAUDE`, or `claude_path` in the policy |

## Environment

| Variable | Does |
|---|---|
| `PLUGBOARD_PROFILE` | The default profile |
| `PLUGBOARD_TRANSPORT` | How calls reach their connectors, over `transport` in policy.toml (below) |
| `PLUGBOARD_AXI` | `1` turns on the AXI output, which is already on inside Claude Code; `0` turns it off |
| `PLUGBOARD_DIRECT` | `0`, from 0.1.3, still means `PLUGBOARD_TRANSPORT=claude-code` |

The transports:
- **`auto`** (the default) calls the connector proxy direct and falls back to Claude Code. When `CLAUDE_CONFIG_DIR` is set, it sends every call through Claude Code instead, as `claude-code` does.
- **`direct`** makes calls without ever starting Claude Code, and fails with exit 10 where `auto` would fall back. Only `refresh` starts it: run `plugboard refresh` once where it can. `doctor` then checks the cache and a direct read per connector instead of Claude Code.
- **`claude-code`** sends every call through Claude Code.

How each one works is in [How it works](../concepts/how-it-works.md#direct-calls).

## Platforms

| Platform | Status |
|---|---|
| macOS (arm64, x64) | Supported; tested in CI on arm64 |
| Linux (x64, arm64) | Supported; tested in CI |
| Windows through WSL2 | Supported; tested in CI on Ubuntu under WSL2. Install Plugboard **and Claude Code inside WSL**: a Windows Claude Code is a separate install with its own login, and Plugboard never uses it. Agents running on the Windows side can call it with `wsl plugboard …` |
| Native Windows | Not yet |

Plugboard finds Claude Code in this order:
1. `PLUGBOARD_CLAUDE`;
2. `claude_path` in the policy;
3. the native installer's `~/.local/bin/claude`;
4. `PATH`.

It keeps its files in the XDG locations, `$XDG_CONFIG_HOME`, `$XDG_CACHE_HOME` and `$XDG_STATE_HOME`, which default to `~/.config`, `~/.cache` and `~/.local/state`. It reads Claude Code transcripts from `$CLAUDE_CONFIG_DIR`, by default `~/.claude`.
