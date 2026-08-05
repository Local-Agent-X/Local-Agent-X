import { startEgressProxy, type EgressProxy } from "./egress-proxy-core.js";
import { getRuntimeConfig } from "../config.js";
import { getLaxDir } from "../lax-data-dir.js";
import { getSharedAuditTrail } from "../threat/audit-trail.js";
import { registerLocalOnlyTeardown } from "../local-only-policy.js";

export type ShellEgressProxy = EgressProxy;

function selfPort(): string {
  return process.env.LAX_PORT ?? String(getRuntimeConfig().port);
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

/** URL of the live shell egress proxy, or null when no proxy is running. */
export function currentShellEgressProxyUrl(): string | null {
  return liveProxyUrl;
}

export function ensureShellEgressProxy(): Promise<ShellEgressProxy> {
  if (!sharedProxy) {
    const starting: Promise<ShellEgressProxy> = startEgressProxy({
      selfPort,
      viaTag: "1.1 lax-shell-egress",
      onPolicyDeny: recordPolicyDeny,
    }).then((proxy) => {
      if (!teardownRegistered) {
        teardownRegistered = true;
        registerLocalOnlyTeardown("shell-egress-proxy", closeShellEgressProxy);
      }
      // Mirror only while this start is still the live singleton: a close()
      // that raced the startup (local-only toggled mid-warm) must not leave
      // a dead port's URL behind.
      if (sharedProxy === starting) liveProxyUrl = proxy.url;
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
  sharedProxy = null;
  liveProxyUrl = null;
  if (active) await (await active).close();
}
