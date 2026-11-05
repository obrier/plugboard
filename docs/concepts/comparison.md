# Compared with alternatives

Four ways to let an agent or a script call Slack, Datadog, Gmail and the rest. They overlap less than they look.

| | Plugboard | MCPorter | Composio / Rube | Native harness MCP |
|---|---|---|---|---|
| What it calls | The connectors you've already connected in claude.ai | Any MCP server you configure (stdio, HTTP, from Cursor/Claude Code/Codex config files) | Composio's hosted MCP for 500–1,500 apps (vendor claim) | Whatever MCP servers that one harness has configured |
| Where you authenticate | Once, in claude.ai. Plugboard never sees a token | Per server, in MCPorter's own OAuth vault | Once, on Composio's servers, which hold your OAuth tokens | Per server, per harness (Gemini CLI, Codex, Hermes each keep their own) |
| Reaches claude.ai connectors | Yes, that's the point | No: they live behind Anthropic's proxy, not in a config file | No, it has its own catalog | Only Claude Code, and only through the model |
| Reaches servers you run yourself | No | Yes | Through Composio's catalog or custom tools | Yes |
| Org-provisioned connectors (admin-enabled, no API key for you) | Yes, if they're in your claude.ai | No | No | Claude Code only |
| Model tokens per call | 0 | 0 | 0 from the CLI; the agent pays schema tokens if loaded as MCP | Schema tokens on every session, plus a model turn per call |
| Read/write policy | Read-only by default; writes need a profile, `--plan` hash, idempotency key; audited; cost guard | None built in | Vendor-side permissions | The harness's own tool permissions |
| Output for agents | `--axi` (TOON, hints, structured errors), `--select`, `--where` | JSON, plus `generate-cli` for typed CLIs | JSON | The MCP response, in context |
| Needs | Claude Code login; macOS, Linux or WSL2; Homebrew, or npm for the library | Node | A Composio account and plan | The harness itself |
| Stability | Drives an internal Claude Code interface; can break on an update, `doctor` detects it | Public MCP protocol | Vendor API | Public MCP protocol |
| License | MIT | MIT | Commercial, free tier | n/a |

MCPorter's star count (about 5.1k) and Composio's app counts are their own published figures, not measured by us.

## When to use which

**Use Plugboard when** the service you need is already connected in claude.ai and you want to call it from a non-Claude agent, a script, or cron. Especially when the connector is one your admin provisioned (Datadog without an API key, an internal data server) and there is no other sanctioned way to reach it. Also when you want a hard read-only default and an audit trail around writes.

**Use MCPorter when** the tool lives on an MCP server you control or configure yourself: a local stdio server, a self-hosted one, or one that isn't in claude.ai's directory. MCPorter is excellent at this, has a daemon, typed clients and `generate-cli`, and it imports server lists from your existing harness configs. It can't reach claude.ai connectors, and Plugboard can't reach arbitrary servers. They sit side by side on the same `PATH` with no conflict.

One line: **MCPorter calls the MCP servers you configure. Plugboard calls the connectors you already have.**

**Use Composio or Rube when** you want one hosted account that works across Cursor, Claude and ChatGPT, you don't have Claude Code, and you're fine with a vendor holding your OAuth tokens. Many companies aren't; check before you connect work accounts.

**Use native harness MCP when** you're working inside one harness, the server is small, and you want the model to pick tools on its own in-chat. Context cost is the trade: Playwright's MCP server is about 13.7k tokens before any work, and one team saw three servers use 143k of a 200k window (figures reported by [Apideck](https://www.apideck.com/blog/mcp-server-eating-context-window-cli-alternative.md) and [Firecrawl](https://firecrawl.dev/blog/mcp-vs-cli)). Plugboard costs zero context until an agent runs `plugboard find`.

## What Plugboard is not

- Not a sandbox. Any program running as you can run `claude` itself. The policy layer guards against bugs and confused automation, not a hostile process.
- Not an MCP client or server. It doesn't speak MCP to anything; it asks Claude Code to make the call.
- Not supported by Anthropic. The interface it drives is internal and undocumented. `plugboard doctor` exits 10 when it breaks, and `claude_path` in the policy file pins an older Claude Code version until a fix ships.
