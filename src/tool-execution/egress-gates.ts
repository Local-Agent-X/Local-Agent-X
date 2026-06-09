// Egress-class policy gates: outbound-secret scan, data-lineage taint floor, and
// canary tripwire. All three key on hasCapability(name, "egress") and share the
// egressPayload extractor, so each off-box sink (http_request/ari_http/email_send/
// clipboard_write/process_start/browser/...) is scanned identically. Sequenced by
// the enforce-policy orchestrator; ORDER is load-bearing and lives there.

import { USER_HINTS, type ToolResult } from "../types.js";
import { checkEgressTaintWithPayload } from "../data-lineage.js";
import { checkCanariesInPayload, recordCanaryExfilAudit } from "../threat/canaries.js";
import { hasCapability } from "../tool-registry.js";
import { checkOutboundRequest, checkOutboundPayload, checkAttachmentPaths } from "../tools/http-egress-guard.js";
import type { PhaseOutcome, ToolCallContext } from "./context.js";
import { terminate, CONTINUE } from "./context.js";

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
    case "process_start":
      push(args.command);
      if (Array.isArray(args.args)) for (const a of args.args) push(a);
      break;
    default:
      // browser navigation/fetch + other egress synonyms: scan url + any
      // model-supplied data payload generically. Off-box sinks that ride their
      // payload in a non-url arg (web_search query/queries[], generate_image/
      // generate_video prompt) are scanned the same way, and local files that
      // get shipped off-box (generate_video reference_image, send_video path)
      // are routed through the sensitive-attachment check.
      push(args.url); push(args.body); push(args.data); push(args.value); push(args.text);
      push(args.query); push(args.prompt);
      if (Array.isArray(args.queries)) for (const q of args.queries) push(q);
      pushLocalFile(args.reference_image, attachmentPaths);
      if (Array.isArray(args.reference_images)) for (const r of args.reference_images) pushLocalFile(r, attachmentPaths);
      pushLocalFile(args.path, attachmentPaths);
      break;
  }
  return { text: parts.join("\n"), attachmentPaths };
}

// Outbound-secret scan for EVERY egress-class sink — keyed on capability class,
// not tool name, so ari_http / email_send / clipboard_write / process_start /
// browser are scanned identically to http_request. http_request keeps its own
// in-tool checkOutboundRequest call (defense in depth); this gate adds the same
// protection to the synonyms that never had it. Also rejects email_send (and
// any egress sink) attaching a sensitive file path.
export function egressGuardGate(ctx: ToolCallContext): PhaseOutcome {
  const { tc, args } = ctx;
  if (!hasCapability(tc.name, "egress")) return CONTINUE;

  // Sensitive-attachment check (Spec F): a sink that reads+sends a file path.
  const { text, attachmentPaths } = egressPayload(tc.name, args as Record<string, unknown>);
  if (attachmentPaths.length > 0) {
    const att = checkAttachmentPaths(tc.name, attachmentPaths);
    if (att) {
      const result: ToolResult = {
        content: `BLOCKED by egress guard: ${att.message}`,
        isError: true,
        status: "blocked",
        metadata: { layer: "egress-guard", ...att.meta, recovery: "Remove the sensitive file from the attachment list — credential/secret files may not be sent off-box.", userHint: USER_HINTS.network },
      };
      return terminate(ctx, { rendered: "model", result, allowed: false });
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
  if (!block) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by egress guard: ${block.message}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "egress-guard", ...block.meta, recovery: "Use {{SECRET_NAME}} placeholders instead of hardcoded credentials, or remove the secret from the outbound payload. Add a trusted destination to ~/.lax/egress-allowlist.json only if it legitimately needs credentials.", userHint: USER_HINTS.network },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

export function dataLineageGate(ctx: ToolCallContext): PhaseOutcome {
  if (!hasCapability(ctx.tc.name, "egress")) return CONTINUE;
  // Presence-based floor is UNCHANGED: a tainted session blocks egress. We use
  // the payload-aware variant only to ENRICH the reason with content-overlap
  // evidence (which tainted bytes are actually in this outbound payload) — it
  // makes the same block decision as checkEgressTaint.
  const { text } = egressPayload(ctx.tc.name, ctx.args as Record<string, unknown>);
  const egress = checkEgressTaintWithPayload(ctx.sessionId || "default", text);
  if (!egress.blocked) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by data lineage: ${egress.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "data-lineage", recovery: "Sensitive data was tainted earlier this session and may not egress. Either don't include the tainted data or end the session.", userHint: USER_HINTS.network },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

// Canary reinforcement of egress. Taint/secret detection is heuristic; a canary
// token is deterministic PROOF — a unique random token planted in the model's
// context that must NEVER legitimately appear in an outbound payload. If one
// shows up in an egress-class payload (raw OR any decoded view), that is
// definitive exfiltration of context: hard-block UNCONDITIONALLY (independent of
// taint state) and write a tamper-evident audit event. The block reason and
// audit reason name the SINK only — the raw canary is never echoed into
// model-visible text or the log (a tripwire revealed teaches evasion).
export function canaryEgressGate(ctx: ToolCallContext): PhaseOutcome {
  if (!hasCapability(ctx.tc.name, "egress")) return CONTINUE;
  const sessionId = ctx.sessionId || "default";
  const { text } = egressPayload(ctx.tc.name, ctx.args as Record<string, unknown>);
  const tripped = checkCanariesInPayload(sessionId, text);
  if (!tripped) return CONTINUE;
  recordCanaryExfilAudit(sessionId, ctx.tc.name);
  const result: ToolResult = {
    content: `BLOCKED by canary tripwire: a session canary token was detected in the outbound payload of "${ctx.tc.name}". This is definitive exfiltration of protected context.`,
    isError: true,
    status: "blocked",
    metadata: { layer: "canary", recovery: "Do not include internal reference codes in outbound payloads. This call was blocked and recorded.", userHint: USER_HINTS.network },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}
