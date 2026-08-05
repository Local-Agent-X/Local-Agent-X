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

export function ensureShellEgressProxy(): Promise<ShellEgressProxy> {
  if (!sharedProxy) {
    sharedProxy = startEgressProxy({
      selfPort,
      viaTag: "1.1 lax-shell-egress",
      onPolicyDeny: recordPolicyDeny,
    }).then((proxy) => {
      if (!teardownRegistered) {
        teardownRegistered = true;
        registerLocalOnlyTeardown("shell-egress-proxy", closeShellEgressProxy);
      }
      return proxy;
    }).catch((error) => {
      sharedProxy = null;
      throw error;
    });
  }
  return sharedProxy;
}

export async function closeShellEgressProxy(): Promise<void> {
  const active = sharedProxy;
  sharedProxy = null;
  if (active) await (await active).close();
}
