/**
 * One tamper-evident audit entry per outbound send the egress cohort stops
 * (ADR 0004 step 2). Until this the only trace of such a block was the threat
 * engine's generic `tool_blocked` / "Security layer blocked", so eight weeks of
 * audit could not tell a secret-scan block from a file-access one, nor "never
 * fired" from "never recorded".
 *
 * The entry names the layer, the tool, where the send was going and WHAT KIND
 * of content stopped it — read from the blocker's structured metadata, never
 * from the payload or the block message, so a secret cannot reach the audit
 * file through it. A tripped canary keeps its own event (recordCanaryExfilAudit).
 */
import { getSharedAuditTrail, type CryptoAuditTrail } from "../threat/audit-trail.js";
import { getLaxDir } from "../lax-data-dir.js";
import { destinationSpecsOf } from "../tool-registry.js";
import type { EgressBlocker } from "./egress-gates.js";

let injected: CryptoAuditTrail | null = null;

/** Test hook — record to a trail rooted at a temp dir. Pass null to reset. */
export function _setEgressBlockAuditTrail(trail: CryptoAuditTrail | null): void {
  injected = trail;
}

// A PreToolUse hook rewrite re-runs the policy phase over the same call: one
// entry per (call, layer, decision), not one per pass.
const recorded = new WeakMap<object, Set<string>>();

/** Where the call was sending: a site's host, or its recipients' count. */
function destinationOf(toolName: string, args: Record<string, unknown>): string {
  for (const spec of destinationSpecsOf(toolName, args) ?? []) {
    if (spec.to === "site") {
      try { return new URL(String(args[spec.arg] ?? "")).host || "unknown host"; } catch { return "unparseable URL"; }
    }
  }
  return "";
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : typeof value === "string" ? value : "";
}

/** The reason line: layer, check, kinds, destination — metadata only. */
export function egressBlockReason(b: EgressBlocker, toolName: string, destination: string): string {
  const meta = b.meta ?? {};
  const parts = [
    `${b.label} stopped ${toolName}`,
    typeof meta.blocked_by === "string" ? `check: ${meta.blocked_by}` : "",
    list(meta.secret_kinds) ? `found: ${list(meta.secret_kinds)}` : "",
    list(meta.data_labels) ? `data: ${list(meta.data_labels)}` : "",
    list(meta.untrusted_recipients) ? `recipients: ${list(meta.untrusted_recipients)}` : "",
    destination ? `to: ${destination}` : "",
  ];
  return parts.filter(Boolean).join("; ");
}

/**
 * Record the blockers the gate enforced: decision "block", or "warn" when the
 * whole set went to the user as a card instead. Never throws: the block must
 * stand even when the audit sink is broken.
 */
export function recordEgressBlocks(
  ctx: { sessionId?: string; tc: { name: string }; args: Record<string, unknown> },
  blockers: readonly EgressBlocker[],
  asked: boolean,
): void {
  const decision = asked ? "warn" : "block";
  const seen = recorded.get(ctx) ?? new Set<string>();
  recorded.set(ctx, seen);
  const destination = destinationOf(ctx.tc.name, ctx.args);
  for (const b of blockers) {
    if (b.layer === "canary" || seen.has(`${b.layer}:${decision}`)) continue;
    seen.add(`${b.layer}:${decision}`);
    try {
      (injected ?? getSharedAuditTrail(getLaxDir())).record({
        sessionId: ctx.sessionId || "default",
        event: "egress_blocked",
        toolName: ctx.tc.name,
        decision,
        reason: egressBlockReason(b, ctx.tc.name, destination),
        controlsApplied: [b.layer],
      });
    } catch { /* the block stands even if the audit sink is broken */ }
  }
}
