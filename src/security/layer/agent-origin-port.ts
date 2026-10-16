/**
 * The agent origin's port, as the egress gate sees it.
 *
 * This server listens twice (server/agent-origin.ts): the UI origin on the
 * configured port, and the agent origin on an ephemeral port that serves what
 * the agent wrote (/apps/*, /dashboards/*, /files/*). The UI origin 302s every
 * app path to the agent origin, so an agent opening its own app in the browser
 * or with http_request always lands on the ephemeral port.
 *
 * The gate's own-server carve-out knew only the configured port, so that
 * redirect target was refused as a private address: the agent could build an
 * app and never look at it (live 2026-10-16, ERR_BLOCKED_BY_CLIENT on
 * 127.0.0.1:53991). The agent origin is the LESS privileged of the two: it
 * accepts no operator token and refuses every /api path except the connector
 * proxy and an app's own state calls, both behind capabilities and both also
 * on the UI origin. Admitting it widens nothing the self-call did not already
 * allow.
 *
 * A leaf with no imports, so the agent origin can set it, network-policy can
 * read it, and the browser egress worker can mirror it into its own thread.
 */

let port: string | null = null;
const listeners = new Set<(port: string | null) => void>();

/** Record the bound port (or null when the listener goes away). */
export function setAgentOriginPort(value: number | string | null): void {
  port = value === null ? null : String(value);
  for (const cb of listeners) cb(port);
}

export function agentOriginPort(): string | null {
  return port;
}

/** Replays the current port on subscribe, then every change. */
export function subscribeAgentOriginPort(cb: (port: string | null) => void): () => void {
  listeners.add(cb);
  cb(port);
  return () => { listeners.delete(cb); };
}
