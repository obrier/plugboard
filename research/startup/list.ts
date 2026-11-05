// Fetches the claude.ai connector list the way Claude Code does (GET /v1/mcp_servers), with the
// login read from the keychain in memory only. Prints timing, the entry fields' names, and per
// connector only its display name, id, stateless flag and whether a cached init response came back.
// Usage: bun list.ts
const p = Bun.spawnSync(["security", "find-generic-password", "-a", process.env.USER ?? "", "-w", "-s", "Claude Code-credentials"], { stderr: "ignore" });
if (p.exitCode !== 0) { console.log(JSON.stringify({ keychainExit: p.exitCode })); process.exit(2); }
const token: string = JSON.parse(p.stdout.toString().trim()).claudeAiOauth.accessToken;
const t0 = performance.now();
const res = await fetch("https://api.anthropic.com/v1/mcp_servers?limit=1000", { headers: {
  Authorization: `Bearer ${token}`, "Content-Type": "application/json",
  "anthropic-beta": "mcp-servers-2025-12-04", "anthropic-version": "2023-06-01",
} });
const ms = Math.round(performance.now() - t0);
const body: any = await res.json().catch(() => undefined);
const data: any[] = body?.data ?? [];
console.log(JSON.stringify({ status: res.status, ms, count: data.length, fields: Object.keys(data[0] ?? {}).sort(),
  error: res.ok ? undefined : String(body?.error?.message ?? "").slice(0, 160),
  servers: data.map(s => ({ name: s.display_name, id: s.id, stateless: s.stateless, cachedInit: s.cached_init_response != null,
    cachedInitProtocol: s.cached_init_response?.protocolVersion, discover: s.discover_support, tools: s.tools?.length })) }, null, 1));
