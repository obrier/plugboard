# How it works

> [!WARNING]
> Plugboard drives an **internal, undocumented interface** of Claude Code. It can break with any Claude Code update (`plugboard doctor` tells you when). It is not affiliated with or endorsed by Anthropic, and using connectors this way may not be covered by their terms. See [Caveats](#caveats).

Claude Code has a JSON control protocol (`--input-format stream-json`) that its SDKs use. Two of its requests are `mcp_status`, which lists connectors and their tools, and `mcp_call`, which calls one. Plugboard starts `claude` with no tools and no model use, and talks to it directly.

## Direct calls

Calls usually skip that start. Claude Code reaches each claude.ai connector through Anthropic's connector proxy, `https://mcp-proxy.anthropic.com/v1/mcp/<connector id>`, with your claude.ai login. `plugboard refresh` records each connector's ID, and a call sends the MCP `tools/call` there itself, with the login Claude Code keeps (read for that run, in memory, never stored): about 0.65 s for a call that takes 2 s through Claude Code.

When the login is missing or about to expire, a connector has no recorded ID, or the proxy refuses the request (400, 401, 403, 404, or no connection), the call goes through Claude Code instead, which also renews the login. Once a request is sent nothing falls back, so a write is never sent twice. The transport `claude-code` always uses Claude Code, and under `direct` nothing does but `refresh` (see [Files and environment](../reference/files.md#environment)).

## Tool schemas

Tool argument schemas aren't part of `mcp_status`. `plugboard refresh` captures them by pointing a second, short-lived `claude` at a local endpoint that reads the tool definitions from the request Claude Code prepares, then rejects it. Nothing is forwarded to a model. Each run then checks that the session cost is still $0.

## Caveats

- **Unsupported interfaces.** The control protocol is internal to Claude Code, and the connector proxy is internal to Anthropic; either can change without notice. A proxy that refuses a direct call sends it through Claude Code. When the control protocol breaks, `plugboard doctor` exits 10, and you can point `claude_path` at a previous version, kept under `~/.local/share/claude/versions/`, until Plugboard catches up. Doctor also makes each connector's check read direct (`direct:<connector>`): a warning says why calls go through Claude Code, and a proxy that fails a read Claude Code made marks the connector blind (exit 7); `PLUGBOARD_TRANSPORT=claude-code` works around it.
- **Terms.** It works technically; that doesn't mean Anthropic, or your connectors' providers, approve of using connectors this way, or of a direct call using Claude Code's login. Check the terms that apply to you, especially before automating writes.
- **Upstream schemas change.** Connector tools gain and lose parameters often. Run `plugboard refresh` regularly; `plugboard doctor --schemas` reports drift.
- **Tool output is data.** Messages and documents can contain text written to steer an AI. Never feed tool output into another call's arguments, or into an agent that can write, without a human in between.
