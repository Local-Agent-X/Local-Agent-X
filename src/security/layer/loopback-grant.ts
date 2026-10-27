/**
 * The one answer to "may the agent reach this loopback port": read by the
 * egress gate (network-policy.ts evaluateWebFetch, for http_request, web_fetch
 * and the browser) and by the shell rules (shell-command-rules.ts, for curl,
 * ssh, nc and the other clients, and for the programs an interpreter is
 * handed inline). A port one may reach, the other may too, except this
 * server's own ports: the egress gate treats those as a self-call made as the
 * agent, under the agent's RBAC, while a shell client carries no such identity
 * and this server's API can proxy on to other hosts, so the shell never gets
 * them.
 *
 * A leaf (no imports from the policy modules) so the gate, the shell rules
 * and the server's bootstrap can all reach it.
 */
import { realpathSync } from "node:fs";
import { isDisposableSandbox } from "./disposable-sandbox.js";
import { ownedUnixSockets } from "../../tools/owned-listeners.js";
import { agentOriginPort } from "./agent-origin-port.js";
import { liveLocalServicePorts, reservedLoopbackPorts } from "./security-config.js";

let ownPort = "7007";

/** The port this server's UI origin listens on, set at startup. */
export function setSelfPort(port: number | string): void {
  ownPort = String(port);
}

export function selfPort(): string {
  return ownPort;
}

/** The port of a URL with none spelled: 443 for https/wss, else 80. */
export function defaultPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : "80";
}

/** Is this one of this server's own ports (the UI origin or the agent origin)? */
export function isOwnServerPort(port: string): boolean {
  return port === ownPort || port === agentOriginPort();
}

/**
 * A loopback port that is a local service the agent may reach: on a machine
 * its operator declared disposable, every port (its services are the
 * operator's, daemons process_start never tracked included); elsewhere, one
 * of `localServicePorts`, the live set of ports LAX started or the user
 * registered. This server's own ports are the caller's to decide.
 */
export function loopbackServiceReachable(port: string | null, localServicePorts: ReadonlySet<string>): boolean {
  // A reserved port (the in-app browser's debugging endpoint) is withheld
  // even where every other loopback port is open.
  if (port !== null && reservedLoopbackPorts().has(port)) return false;
  if (isDisposableSandbox()) return true;
  return port !== null && localServicePorts.has(port);
}

/** May a shell network client reach this loopback port? */
export function shellLoopbackReachable(port: string): boolean {
  if (isOwnServerPort(port)) return false;
  return loopbackServiceReachable(port, liveLocalServicePorts());
}

/**
 * May a shell client or an inline program reach this Unix socket? Every one
 * on a disposable sandbox, whose local services are the operator's; elsewhere
 * one a process the agent started listens on (owned-listeners.ts), as a port
 * is reachable while the agent's own server holds it. docker.sock, an
 * ssh-agent or the session bus are no process of the agent's: control of the
 * machine, the user's keys and the desktop stay out of reach.
 */
export function shellUnixSocketReachable(path: string): boolean {
  if (isDisposableSandbox()) return true;
  let real: string;
  try { real = realpathSync(path); } catch { return false; /* nothing there to reach */ }
  return ownedUnixSockets().has(real);
}
