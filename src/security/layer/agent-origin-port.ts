/**
 * The agent origins' ports, as the egress gate sees them.
 *
 * This server listens more than once (server/agent-origin.ts): the UI origin
 * on the configured port, a shared agent origin on an ephemeral port that
 * serves workspace files (/files/*), and one listener per app, each on its own
 * port, that serves that app alone (/apps/<id>/*, /dashboards/<id>/*;
 * server/app-origins.ts). The UI origin 302s every app path to that app's
 * listener, so an agent opening its own app in the browser or with
 * http_request always lands on one of these ports.
 *
 * The gate's own-server carve-out knew only the configured port, so that
 * redirect target was refused as a private address: the agent could build an
 * app and never look at it (live 2026-10-16, ERR_BLOCKED_BY_CLIENT on
 * 127.0.0.1:53991). These origins are LESS privileged than the UI origin:
 * they accept no operator token and refuse every /api path except the ones a
 * capability injected into the page opens.
 *
 * A leaf with no imports, so the agent origin can set it, network-policy can
 * read it, and the browser egress worker can mirror it into its own thread.
 */

let shared: string | null = null;
const apps = new Set<string>();
const listeners = new Set<(ports: string[]) => void>();

function notify(): void {
  const ports = agentOriginPorts();
  for (const cb of listeners) cb(ports);
}

/** Record the shared agent origin's bound port (or null when it goes away). */
export function setAgentOriginPort(value: number | string | null): void {
  shared = value === null ? null : String(value);
  notify();
}

/** Record one app's listener port. */
export function addAppOriginPort(value: number | string): void {
  apps.add(String(value));
  notify();
}

export function removeAppOriginPort(value: number | string): void {
  if (apps.delete(String(value))) notify();
}

/** Every agent-origin port bound right now: the shared one and each app's. */
export function agentOriginPorts(): string[] {
  return shared === null ? [...apps] : [shared, ...apps];
}

export function isAgentOriginPort(port: string): boolean {
  return port !== "" && (port === shared || apps.has(port));
}

/** Replace the whole set with another thread's snapshot (the egress worker's
 *  module instance is its own and hears the main thread's set this way). */
export function mirrorAgentOriginPorts(ports: readonly string[]): void {
  shared = null;
  apps.clear();
  for (const port of ports) apps.add(port);
  notify();
}

/** Replays the current ports on subscribe, then every change. */
export function subscribeAgentOriginPorts(cb: (ports: string[]) => void): () => void {
  listeners.add(cb);
  cb(agentOriginPorts());
  return () => { listeners.delete(cb); };
}
