import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { startEgressProxy, type EgressProxy } from "./egress-proxy-core.js";
import { bridgeSocketPath, startShellEgressBridge, sweepStaleBridgeSockets, type ShellEgressBridge } from "./shell-egress-bridge.js";
import { loadEgressConfig } from "../security/layer/network-policy.js";
import { getRuntimeConfig } from "../config.js";
import { getLaxDir } from "../lax-data-dir.js";
import { getSharedAuditTrail } from "../threat/audit-trail.js";
import { registerLocalOnlyTeardown } from "../local-only-policy.js";
import { createLogger } from "../logger.js";

const logger = createLogger("net.shell-egress-proxy");

export type ShellEgressProxy = EgressProxy;

function selfPort(): string {
  return process.env.LAX_PORT ?? String(getRuntimeConfig().port);
}

/**
 * The loopback ports the shell proxy may bind. Fixed, not ephemeral: a cage
 * that permits loopback to a range (the Windows fence) is configured before
 * any shell runs, so the proxy has to live where the permit points. Ten ports
 * leave room for a second LAX instance on the machine; the range sits just
 * above the one Anthropic's sandbox runtime uses by default (60080–60089) so
 * the two products never share a permit. `LAX_SHELL_PROXY_PORTS=from-to`
 * overrides it.
 */
export const SHELL_PROXY_PORTS_DEFAULT = { from: 60090, to: 60099 } as const;

export function shellProxyPortRange(): { from: number; to: number } {
  const raw = process.env.LAX_SHELL_PROXY_PORTS;
  const m = raw ? /^(\d{1,5})-(\d{1,5})$/.exec(raw.trim()) : null;
  if (!m) return { ...SHELL_PROXY_PORTS_DEFAULT };
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1024 || to > 65535 || to < from) {
    throw new Error(`LAX_SHELL_PROXY_PORTS must be "from-to" with 1024 <= from <= to <= 65535, got "${raw}"`);
  }
  return { from, to };
}

function recordPolicyDeny(info: { target: string; reason: string }): void {
  // INVARIANT: audit emission must never throw into the proxy's deny path.
  try {
    getSharedAuditTrail(getLaxDir()).record({
      sessionId: "shell-egress-proxy",
      event: "shell_egress_denied",
      toolName: "bash",
      decision: "block",
      reason: `${info.reason} (target: ${info.target})`,
    });
  } catch { /* the 403 must still ship even if the audit sink is broken */ }
}

let sharedProxy: Promise<ShellEgressProxy> | null = null;
let teardownRegistered = false;

// Synchronous mirror of the live proxy's URL. This is the ONE source of truth
// for "is there a sanctioned egress route right now" that sync callers (the
// spawn paths in shell-proxy-env.ts) may read — non-null exactly while the
// singleton is up. Set on successful start, cleared on close AND failed start,
// so nothing downstream can hold a URL that outlives the listener.
let liveProxyUrl: string | null = null;
// The Linux bridge (shell-egress-bridge.ts), same currency rule as the URL.
let liveBridge: ShellEgressBridge | null = null;

/** URL of the live shell egress proxy, or null when no proxy is running. */
export function currentShellEgressProxyUrl(): string | null {
  return liveProxyUrl;
}

/**
 * The loopback ports a caged shell may reach: this server's own port, the
 * registered local services — the one union http_request is judged by
 * (loadEgressConfig, which already withholds the reserved ports) — and the
 * port of THIS instance's live egress proxy, the one sanctioned route out.
 * Never the proxy's whole range: another instance on the machine (an eval
 * server, a second data dir) binds its proxy in the same range, and admitting
 * the range would let a caged shell egress under that instance's policy. The
 * shell overlay awaits the proxy before the spawn (shell-proxy-env.ts), so the
 * live port is known when a profile is generated; if the proxy is not up the
 * cage has no route out, which is the fail-closed posture. Read at call time
 * so a dev server registered mid-session counts for the next spawn. Linux
 * bridges these ports into the namespace; macOS allows them in the seatbelt
 * profile.
 */
export function cageLoopbackPorts(): number[] {
  const ports = new Set<number>([Number(selfPort())]);
  for (const p of loadEgressConfig().localServicePorts) ports.add(Number(p));
  if (liveProxyUrl) ports.add(Number(new URL(liveProxyUrl).port));
  return [...ports].filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
}

/** The unix socket a Linux cage reaches the host through, or null: the live
 *  proxy's port plus the loopback ports the forwarder should listen on now. */
export function currentShellEgressBridge(): { socketPath: string; port: number; loopbackPorts: number[] } | null {
  return liveBridge ? { socketPath: liveBridge.socketPath, port: liveBridge.port, loopbackPorts: cageLoopbackPorts() } : null;
}

/** Where a Linux cage's bridge socket lives: a 0700 dir under the data dir. */
function runDir(): string {
  return join(getLaxDir(), "run");
}

// The bridge is Linux-only: macOS guarded allows the same ports in its
// seatbelt profile and the Windows cage permits the proxy port. A bridge that fails to start leaves the
// proxy up for what can reach it and the cage without a route — fail closed,
// said in the log.
async function startBridge(proxy: ShellEgressProxy): Promise<ShellEgressBridge | null> {
  if (process.platform !== "linux") return null;
  try {
    sweepStaleBridgeSockets(runDir());
    // Admission is decided per connection, at connect time: a port that was
    // registered when the shell spawned but is not any more is refused.
    return await startShellEgressBridge(proxy.port, bridgeSocketPath(runDir()), (port) => cageLoopbackPorts().includes(port));
  } catch (e) {
    logger.warn(`shell egress bridge failed to start; Linux guarded shells have no route out until it does: ${(e as Error).message}`);
    return null;
  }
}

export function ensureShellEgressProxy(): Promise<ShellEgressProxy> {
  if (!sharedProxy) {
    // The token is per proxy instance: it lives only in the URL the caged
    // shell's env carries, never in a log line or an audit row.
    const starting: Promise<ShellEgressProxy> = startEgressProxy({
      ports: shellProxyPortRange(),
      authToken: randomBytes(16).toString("hex"),
      selfPort,
      viaTag: "1.1 lax-shell-egress",
      onPolicyDeny: recordPolicyDeny,
    }).then(async (proxy) => {
      if (!teardownRegistered) {
        teardownRegistered = true;
        registerLocalOnlyTeardown("shell-egress-proxy", closeShellEgressProxy);
      }
      const bridge = await startBridge(proxy);
      // Mirror only while this start is still the live singleton: a close()
      // that raced the startup (local-only toggled mid-warm) must not leave
      // a dead port's URL behind.
      if (sharedProxy === starting) {
        liveProxyUrl = proxy.url;
        liveBridge = bridge;
      } else {
        await bridge?.close();
      }
      return proxy;
    }).catch((error) => {
      // Same currency guard as the .then: if a close()+re-ensure raced this
      // failed start, a newer singleton (and its mirror) is live — clobbering
      // it here would orphan that listener and force a spurious third start.
      if (sharedProxy === starting) {
        sharedProxy = null;
        liveProxyUrl = null;
      }
      throw error;
    });
    sharedProxy = starting;
  }
  return sharedProxy;
}

export async function closeShellEgressProxy(): Promise<void> {
  const active = sharedProxy;
  const bridge = liveBridge;
  sharedProxy = null;
  liveProxyUrl = null;
  liveBridge = null;
  await bridge?.close();
  if (active) await (await active).close();
}
