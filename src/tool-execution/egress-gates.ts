// Egress-class policy gates: outbound-secret scan, data-lineage taint floor, and
// canary tripwire. All three key on hasCapability(name, "egress") and share the
// egressPayload extractor, so each off-box sink (http_request/ari_http/email_send/
// clipboard_write/process_start/browser/...) is scanned identically. Sequenced by
// the enforce-policy orchestrator; ORDER is load-bearing and lives there.
//
// SC-10: the three gates used to run in sequence and each return its OWN
// first-deny, so a request denied by more than one layer surfaced one blocker per
// turn (fix the taint → retry → hit the allowlist → …). Every gate's enforcement
// logic is now factored into a side-effect-free `probe*` predicate. The single
// gates still block exactly as before, but the orchestrator can also run every
// probe in one "what-else-would-block" pass (egressAggregateGate) and report the
// WHOLE chain — each blocker tagged with its authoritative layer — in one turn.
// The only non-pure step (the canary exfil audit) is applied by the ENFORCING
// caller exactly once, never inside a probe, so no gate is double-run with a side
// effect.

import { USER_HINTS, type ToolResult } from "../types.js";
import { checkEgressTaintWithPayload } from "../data-lineage/index.js";
import { checkCanariesInPayload, recordCanaryExfilAudit } from "../threat/canaries.js";
import { hasCapability } from "../tool-registry.js";
import { checkOutboundRequest, checkOutboundPayload, checkAttachmentPaths } from "../tools/http-egress-guard.js";
import type { PhaseOutcome, ToolCallContext } from "./context.js";
import { terminate, CONTINUE } from "./context.js";

// One outbound blocker: the layer that enforces it, a human label for the
// single-gate "BLOCKED by <label>" line, the specific reason, recovery guidance,
// a user hint, and any extra metadata (blocked_by / secret_kinds / paths) that a
// single-gate result carries. Consumed both by the single gates (one blocker →
// one ToolResult) and by the aggregate (many blockers → one ToolResult).
export interface EgressBlocker {
  layer: string;
  label: string;
  reason: string;
  recovery: string;
  userHint: string;
  meta?: Record<string, unknown>;
}

// Extract the OUTBOUND payload an egress-class sink would emit, so the secret
// scan covers every channel (not just http body). Returns the scannable text +
// any file paths the sink would attach. Keyed by tool name because each sink
// carries its payload in differently-named args.
function egressPayload(name: string, args: Record<string, unknown>): { text: string; attachmentPaths: string[] } {
  const parts: string[] = [];
  const attachmentPaths: string[] = [];
  const push = (v: unknown) => { if (v != null && v !== "") parts.push(String(v)); };
  // A model-supplied reference-image / video path that names a LOCAL file is a
  // candidate sensitive attachment (its bytes get shipped off-box). Remote
  // http(s)/data: refs aren't local-file reads, so skip them here.
  const pushLocalFile = (v: unknown, into: string[]) => {
    if (typeof v !== "string" || v === "") return;
    if (/^(https?:|data:)/i.test(v)) return;
    into.push(v);
  };
  switch (name) {
    case "http_request":
    case "ari_http":
      push(args.body);
      if (args.headers && typeof args.headers === "object") {
        for (const v of Object.values(args.headers as Record<string, unknown>)) push(v);
      }
      break;
    case "email_send":
      push(args.to); push(args.cc); push(args.subject); push(args.body);
      if (args.attachments) {
        try {
          const paths = JSON.parse(String(args.attachments));
          if (Array.isArray(paths)) for (const p of paths) attachmentPaths.push(String(p));
        } catch { /* malformed attachments JSON — the tool will reject it */ }
      }
      break;
    case "clipboard_write":
      push(args.text);
      break;
    case "computer":
      // The `computer` family's ONLY exfil channel is the text it types
      // (action:"type"); mouse move/click/drag and key chords carry no data.
      push(args.text);
      break;
    case "process_start":
      push(args.command);
      if (Array.isArray(args.args)) for (const a of args.args) push(a);
      break;
    default:
      // browser navigation/fetch + other egress synonyms: scan url + any
      // model-supplied data payload generically. Off-box sinks that ride their
      // payload in a non-url arg (web_search query/queries[], generate_image/
      // generate_video prompt) are scanned the same way, and local files that
      // get shipped off-box (generate_video reference_image, edit_image
      // image/mask, send_video path) are routed through the sensitive-attachment
      // check — edit_image inlines the source file as base64, so a secret path
      // passed as `image` would exfiltrate without this.
      push(args.url); push(args.body); push(args.data); push(args.value); push(args.text);
      push(args.query); push(args.prompt);
      if (Array.isArray(args.queries)) for (const q of args.queries) push(q);
      pushLocalFile(args.reference_image, attachmentPaths);
      if (Array.isArray(args.reference_images)) for (const r of args.reference_images) pushLocalFile(r, attachmentPaths);
      pushLocalFile(args.image, attachmentPaths);
      pushLocalFile(args.mask, attachmentPaths);
      pushLocalFile(args.path, attachmentPaths);
      break;
  }
  return { text: parts.join("\n"), attachmentPaths };
}

// Build the single-gate ToolResult for one blocker. Reproduces the exact
// content/metadata shape the three gates emitted before the SC-10 refactor.
function blockerResult(b: EgressBlocker): ToolResult {
  return {
    content: `BLOCKED by ${b.label}: ${b.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: b.layer, ...(b.meta ?? {}), recovery: b.recovery, userHint: b.userHint },
  };
}

// ── Pure, side-effect-free probes (one per egress gate) ──────────────────────

// Outbound-secret scan for EVERY egress-class sink — keyed on capability class,
// not tool name, so ari_http / email_send / clipboard_write / process_start /
// browser are scanned identically to http_request. http_request keeps its own
// in-tool checkOutboundRequest call (defense in depth); this gate adds the same
// protection to the synonyms that never had it. Also rejects email_send (and any
// egress sink) attaching a sensitive file path. Pure: no state mutated.
export function probeEgressGuard(ctx: ToolCallContext): EgressBlocker | null {
  const { tc, args } = ctx;
  if (!hasCapability(tc.name, "egress")) return null;

  const { text, attachmentPaths } = egressPayload(tc.name, args as Record<string, unknown>);
  // Sensitive-attachment check (Spec F): a sink that reads+sends a file path.
  if (attachmentPaths.length > 0) {
    const att = checkAttachmentPaths(tc.name, attachmentPaths);
    if (att) {
      return {
        layer: "egress-guard", label: "egress guard", reason: att.message,
        recovery: "Remove the sensitive file from the attachment list — credential/secret files may not be sent off-box.",
        userHint: USER_HINTS.outboundContent, meta: att.meta,
      };
    }
  }

  // Outbound-secret scan. http-shaped sinks go through the host-allowlist-aware
  // checkOutboundRequest; the rest through the destination-less payload scan.
  let block: { message: string; meta: Record<string, unknown> } | null = null;
  if (tc.name === "http_request" || tc.name === "ari_http") {
    block = checkOutboundRequest({
      url: String(args.url ?? ""),
      method: String(args.method ?? "POST").toUpperCase(),
      body: args.body,
      headers: args.headers,
    });
  } else {
    block = checkOutboundPayload(tc.name, text);
  }
  if (!block) return null;
  return {
    layer: "egress-guard", label: "egress guard", reason: block.message,
    recovery: "Use {{SECRET_NAME}} placeholders instead of hardcoded credentials, or remove the secret from the outbound payload. Add a trusted destination to ~/.lax/egress-allowlist.json only if it legitimately needs credentials.",
    userHint: USER_HINTS.outboundContent, meta: block.meta,
  };
}

// Data-lineage taint floor. Completeness-guarded Option B+
// (checkEgressTaintWithPayload): a tainted session still blocks egress UNLESS
// every active taint entry is fully fingerprinted AND this outbound payload
// overlaps none of them. Pure: reads the session taint map, mutates nothing.
export function probeDataLineage(ctx: ToolCallContext): EgressBlocker | null {
  if (!hasCapability(ctx.tc.name, "egress")) return null;
  const { text } = egressPayload(ctx.tc.name, ctx.args as Record<string, unknown>);
  // `computer` is egress ONLY through typed text (action:"type"). A mouse
  // move/click/scroll carries no data, so the sticky presence floor must not
  // gate it — blocking a cursor move because a file was read earlier this
  // session is a pure false positive with nothing to exfil.
  if (ctx.tc.name === "computer" && text === "") return null;
  const egress = checkEgressTaintWithPayload(ctx.sessionId || "default", text);
  if (!egress.blocked) return null;
  return {
    layer: "data-lineage", label: "data lineage",
    reason: egress.reason ?? "The session is tainted by an earlier sensitive read; outbound data is blocked.",
    recovery: "Sensitive data was tainted earlier this session and may not egress. Either don't include the tainted data or end the session.",
    userHint: USER_HINTS.outboundContent,
  };
}

// Canary tripwire. A canary token is deterministic PROOF of context
// exfiltration. This probe only DETECTS the trip (checkCanariesInPayload is
// pure) — it deliberately does NOT write the tamper-evident audit event; the
// enforcing caller (canaryEgressGate / egressAggregateGate) records it exactly
// once. The reason names the SINK only — the raw canary is never echoed.
export function probeCanary(ctx: ToolCallContext): EgressBlocker | null {
  if (!hasCapability(ctx.tc.name, "egress")) return null;
  const { text } = egressPayload(ctx.tc.name, ctx.args as Record<string, unknown>);
  const tripped = checkCanariesInPayload(ctx.sessionId || "default", text);
  if (!tripped) return null;
  return {
    layer: "canary", label: "canary tripwire",
    reason: `a session canary token was detected in the outbound payload of "${ctx.tc.name}". This is definitive exfiltration of protected context.`,
    recovery: "Do not include internal reference codes in outbound payloads. This call was blocked and recorded.",
    userHint: USER_HINTS.outboundContent,
  };
}

// ── Single-gate enforcement wrappers (behaviour-preserving) ──────────────────

export function egressGuardGate(ctx: ToolCallContext): PhaseOutcome {
  const b = probeEgressGuard(ctx);
  if (!b) return CONTINUE;
  return terminate(ctx, { rendered: "model", result: blockerResult(b), allowed: false });
}

export function dataLineageGate(ctx: ToolCallContext): PhaseOutcome {
  const b = probeDataLineage(ctx);
  if (!b) return CONTINUE;
  return terminate(ctx, { rendered: "model", result: blockerResult(b), allowed: false });
}

export function canaryEgressGate(ctx: ToolCallContext): PhaseOutcome {
  const b = probeCanary(ctx);
  if (!b) return CONTINUE;
  // Definitive exfil: write the tamper-evident audit event (the single side
  // effect in this file, applied here by the enforcing gate — never in a probe).
  recordCanaryExfilAudit(ctx.sessionId || "default", ctx.tc.name);
  return terminate(ctx, { rendered: "model", result: blockerResult(b), allowed: false });
}

// ── Aggregation across the egress cohort (SC-10) ─────────────────────────────

// Run the data-lineage + canary + egress-guard probes in one side-effect-free
// pass and return every blocker the request would hit. `canaryTripped` tells the
// enforcing caller whether it owes the (one-time) canary exfil audit.
export function probeEgressCohort(ctx: ToolCallContext): { blockers: EgressBlocker[]; canaryTripped: boolean } {
  const blockers: EgressBlocker[] = [];
  if (!hasCapability(ctx.tc.name, "egress")) return { blockers, canaryTripped: false };
  const lineage = probeDataLineage(ctx);
  if (lineage) blockers.push(lineage);
  const canary = probeCanary(ctx);
  if (canary) blockers.push(canary);
  const guard = probeEgressGuard(ctx);
  if (guard) blockers.push(guard);
  return { blockers, canaryTripped: canary !== null };
}

// Render ONE response for a list of blockers. A single blocker reproduces the
// legacy single-gate result verbatim; multiple blockers become a numbered list,
// each line tagged with its authoritative layer + its own fix, so the model
// resolves the whole chain in one turn instead of one blocker per turn.
export function renderEgressAggregate(ctx: ToolCallContext, blockers: EgressBlocker[]): PhaseOutcome {
  // Each enforcement layer contributes at most one line (first wins).
  const seen = new Set<string>();
  const unique = blockers.filter((b) => (seen.has(b.layer) ? false : (seen.add(b.layer), true)));
  if (unique.length === 1) {
    return terminate(ctx, { rendered: "model", result: blockerResult(unique[0]), allowed: false });
  }
  const lines = unique.map((b, i) => `  ${i + 1}. [${b.layer}] ${b.reason}\n     → fix: ${b.recovery}`);
  const content =
    `BLOCKED — this outbound call is denied by ${unique.length} policy layers at once. ` +
    `Resolve EVERY blocker below before retrying; fixing only one will just surface the next:\n` +
    lines.join("\n");
  const result: ToolResult = {
    content,
    isError: true,
    status: "blocked",
    metadata: {
      layer: "egress-aggregate",
      layers: unique.map((b) => b.layer),
      blockers: unique.map((b) => ({ layer: b.layer, reason: b.reason, recovery: b.recovery, ...(b.meta ?? {}) })),
      recovery: unique.map((b) => `[${b.layer}] ${b.recovery}`).join("  "),
      userHint: unique[0].userHint,
    },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

// Single egress gate for the orchestrator: aggregates data-lineage + canary +
// egress-guard into ONE response, PREPENDED with any `upstream` blockers already
// determined by earlier gates (kernel taint deny, security layer) so a tainted
// POST denied at the kernel still surfaces the downstream allowlist blocker in
// the SAME turn. Enforcement is unchanged — a non-empty blocker set still blocks;
// only the REPORTED reason becomes the aggregate.
export function egressAggregateGate(ctx: ToolCallContext, upstream: EgressBlocker[] = []): PhaseOutcome {
  const { blockers, canaryTripped } = probeEgressCohort(ctx);
  const all = [...upstream, ...blockers];
  if (all.length === 0) return CONTINUE;
  // Apply the canary audit exactly once, here, when the canary is part of the
  // enforced aggregate (probeCanary is side-effect-free by design).
  if (canaryTripped) recordCanaryExfilAudit(ctx.sessionId || "default", ctx.tc.name);
  return renderEgressAggregate(ctx, all);
}
