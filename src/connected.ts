import type { ConnectorServer } from "./bridge/client";
import type { Manifest } from "./cache";
import { fail } from "./errors";

export const BIN = "plugboard";

/** A live server must be connected; anything else is AUTH_REQUIRED (needs-auth, failed) or NOT_FOUND. */
export function requireConnected(servers: ConnectorServer[], manifest: Manifest) {
  const server = servers.find(s => s.name === manifest.connectorName);
  if (!server) throw fail("NOT_FOUND", `${manifest.connectorName} is no longer listed by Claude Code`, [`Run \`${BIN} refresh\``]);
  if (server.status !== "connected") throw fail("AUTH_REQUIRED", `${manifest.connectorName} is ${server.status}`, [
    `Reconnect it in claude.ai → Settings → Connectors${server.error ? ` (${server.error.slice(0, 120)})` : ""}`,
  ]);
}
