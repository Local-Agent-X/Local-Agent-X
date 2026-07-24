import { createHash } from "node:crypto";

export type MemoryContentOrigin =
  | "user_statement" | "assistant" | "tool_observation"
  | "external" | "import" | "unknown" | "durable_memory";

export interface MemoryPromotionClaims {
  content: string;
  target: string;
  source: string;
  sessionId: string;
  provenance: string;
  confidence: number;
  origin: MemoryContentOrigin;
  evidenceSpan?: string;
}

export interface MemoryPromotionCapability { readonly kind: "memory-promotion" }

export interface MemoryPromotionContext {
  origin: MemoryContentOrigin;
  sessionId?: string;
  source?: string;
  target?: string;
  provenance?: string;
  confidence?: number;
  evidenceContent?: string;
  capability?: MemoryPromotionCapability;
}

export interface MemoryPromotionRequest extends MemoryPromotionClaims {}

const CAPABILITY = Symbol("memory-promotion-capability");
const states = new WeakMap<object, { claims: MemoryPromotionClaims; consumed: boolean }>();

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mint(claims: MemoryPromotionClaims): MemoryPromotionCapability {
  const capability = Object.freeze({ kind: "memory-promotion" as const });
  states.set(capability, { claims: { ...claims }, consumed: false });
  return capability;
}

function normalizedWords(text: string): string[] {
  const stop = new Set(["the", "a", "an", "to", "that", "this", "my", "me", "i", "user", "please", "remember", "save", "profile", "project", "is", "am", "are", "be", "of", "in", "and", "prefer", "response", "respons", "without", "current", "currently", "tak", "taking"]);
  return (text.toLowerCase().match(/[a-z0-9@]+/g) ?? [])
    .map((word) => word.replace(/^@/, "").replace(/(?:ing|ed|es|s)$/, ""))
    .map((word) => (["hate", "dislik"].includes(word) ? "aversion" : ["love", "lov", "like"].includes(word) ? "affinity" : word))
    .filter((word) => word.length > 1 && !stop.has(word));
}

function supportedBy(span: string, proposed: string): boolean {
  const evidence = new Set(normalizedWords(span));
  const claims = normalizedWords(proposed);
  if (claims.length === 0) return false;
  const proposedNumbers = proposed.match(/\d+/g) ?? [];
  if (proposedNumbers.some((number) => !span.includes(number))) return false;
  return claims.filter((word) => evidence.has(word)).length / claims.length >= 0.6;
}

export function createUserEvidenceCapability(input: Omit<MemoryPromotionClaims, "origin"> & {
  userMessage: string;
  evidenceSpan: string;
}): MemoryPromotionCapability {
  if (!input.evidenceSpan || !input.userMessage.includes(input.evidenceSpan)) {
    throw new Error("supporting user span is not present in the current user turn");
  }
  if (!supportedBy(input.evidenceSpan, input.content)) {
    throw new Error("proposed memory is not supported by the current user span");
  }
  return mint({ ...input, origin: "user_statement" });
}

export function createInternalMemoryCapability(
  claims: Omit<MemoryPromotionClaims, "origin">,
): MemoryPromotionCapability {
  return mint({ ...claims, origin: "durable_memory" });
}

export function createInternalMemoryContext(
  content: string,
  target: string,
  source: string,
  sessionId = "internal",
): MemoryPromotionContext {
  const provenance = "durable_memory";
  const confidence = 1;
  const capability = createInternalMemoryCapability({ content, target, source, sessionId, provenance, confidence });
  return { origin: "durable_memory", capability, evidenceContent: content, target, source, sessionId, provenance, confidence };
}

export function createImportedMemoryContext(
  content: string,
  target: string,
  source: string,
  sessionId: string,
): MemoryPromotionContext {
  const provenance = "import";
  const confidence = 1;
  const capability = mint({ content, target, source, sessionId, provenance, confidence, origin: "import" });
  return { origin: "import", capability, evidenceContent: content, target, source, sessionId, provenance, confidence };
}

export function assertMemoryPromotionCapability(
  capability: MemoryPromotionCapability | undefined,
  expected: Omit<MemoryPromotionClaims, "evidenceSpan">,
  consume = true,
): void {
  const state = capability ? states.get(capability) : undefined;
  // Two distinct failures, two distinct messages: a MISSING capability means
  // the approval-phase stamp never reached the sink (dispatch plumbing bug —
  // e.g. an arg clone dropping the symbol), while mismatched CLAIMS mean the
  // gate and the sink computed different provenance/confidence/target for the
  // same write (policy-twin divergence). Conflating them cost days of
  // diagnosis when retry-call cloning broke every memory write in Jul 2026.
  if (!state) {
    throw new Error(
      "memory promotion capability required but none is attached — the approval-phase stamp was lost between gate and sink (dispatch plumbing bug), or the caller never minted one",
    );
  }
  const claims = state.claims;
  const matches = hash(claims.content) === hash(expected.content)
    && claims.target === expected.target
    && claims.source === expected.source
    && claims.sessionId === expected.sessionId
    && claims.provenance === expected.provenance
    && claims.confidence === expected.confidence
    && claims.origin === expected.origin;
  if (!matches) {
    throw new Error(
      "memory promotion capability claims do not match this write — gate and sink disagree on content/target/source/session/provenance/confidence/origin",
    );
  }
  if (consume && state.consumed) throw new Error("memory promotion capability has already been consumed");
  if (consume) state.consumed = true;
}

function factMetadata(args: Record<string, unknown>): { provenance: string; confidence: number } {
  // Normalize exactly like the fact-tool sinks (parseProvenance in
  // memory/tools/facts.ts): an off-enum provenance falls back to "inference".
  // The sinks verify these claims against their own recomputation, so any
  // divergence here bricks the write with a claims mismatch.
  const raw = String(args.provenance || "inference");
  const declared = ["user_statement", "tool_observation", "inference"].includes(raw) ? raw : "inference";
  const cap = declared === "user_statement" ? 1 : 0.6;
  const requested = args.confidence == null ? cap : Number(args.confidence);
  return {
    provenance: `model-declared:${declared}`,
    confidence: Math.min(Number.isFinite(requested) ? requested : cap, cap),
  };
}

export function describeMemoryPromotionRequest(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string,
): MemoryPromotionRequest | null {
  let content = "";
  let target = "";
  if (toolName === "remember") { content = String(args.content || "").trim(); target = "memory:retain"; }
  else if (toolName === "update_fact") { content = String(args.content || "").trim(); target = `memory:update:${String(args.query || "").trim()}`; }
  else if (toolName === "memory_save") { content = String(args.content || ""); target = "memory:daily-log"; }
  else if (toolName === "memory_set_user_field") { content = `${String(args.field || "").trim()}: ${String(args.value || "").trim()}`; target = "memory:profile:user-field"; }
  else if (toolName === "memory_update_profile") { content = String(args.content || ""); target = `memory:profile:${String(args.file || "unknown")}`; }
  else if (toolName === "project_brief_update") { content = String(args.content || "").trim(); target = "memory:project-brief"; }
  else if (toolName === "project_create") { content = String(args.summary || "").trim(); target = "memory:project-brief"; }
  else return null;
  if (!content.trim()) return null;
  const metadata = factMetadata(args);
  return { content, target, sessionId, source: `model-tool:${toolName}`, ...metadata, origin: "assistant" };
}

/** Plain-English name for a promotion target, for the approval card. The raw
 *  target ("memory:daily-log", "memory:profile:user-field") is an internal
 *  routing key; a person approving the write needs to know WHERE it lands. */
function friendlyTarget(target: string): string {
  if (target === "memory:daily-log") return "your daily activity log";
  if (target === "memory:retain" || target.startsWith("memory:update:")) return "your long-term memory";
  if (target === "memory:project-brief") return "the project brief";
  if (target.startsWith("memory:profile")) return "your saved profile";
  return "long-term memory";
}

/** The approval-card question a non-engineer can actually act on: says what is
 *  being saved and where, in plain language, with the content quoted. Replaces
 *  the old "Promote this exact model-originated content… Source=…; target=…"
 *  wording that read as jargon to everyone but its author. */
export function describePromotionForHuman(promotion: MemoryPromotionClaims): string {
  const oneLine = promotion.content.trim().replace(/\s+/g, " ");
  const excerpt = oneLine.length > 240 ? oneLine.slice(0, 240) + "…" : oneLine;
  return `Save this to ${friendlyTarget(promotion.target)} so I can use it in future chats?\n\n“${excerpt}”`;
}

const UNTRUSTED_MARKERS = /EXTERNAL_UNTRUSTED_CONTENT|INJECTION WARNING/i;

function currentUserTurn(priorMessages: unknown[] | undefined): { text: string; turnTail: string } {
  if (!priorMessages) return { text: "", turnTail: "" };
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const message = priorMessages[i] as { role?: string; content?: unknown };
    if (message.role === "user" && typeof message.content === "string") {
      const turnTail = priorMessages.slice(i + 1)
        .map((later) => {
          const content = (later as { content?: unknown }).content;
          return typeof content === "string" ? content : JSON.stringify(content ?? "");
        })
        .join("\n");
      return { text: message.content, turnTail };
    }
  }
  return { text: "", turnTail: "" };
}

// Trusted-user evidence needs no save-intent phrasing: any current-turn user
// statement the proposed memory is verbatim-supported by (supportedBy's
// overlap + number checks) is the user's own words, which cannot be laundered
// external content. Off-box laundering is guarded one level up by the
// session-level ingestion taint and here by the untrusted-content markers.
export function trustedCurrentUserEvidence(
  request: MemoryPromotionRequest,
  priorMessages: unknown[] | undefined,
): { userMessage: string; evidenceSpan: string } | null {
  const turn = currentUserTurn(priorMessages);
  const userMessage = turn.text;
  if (!userMessage || UNTRUSTED_MARKERS.test(userMessage)) return null;
  return supportedBy(userMessage, request.content) ? { userMessage, evidenceSpan: userMessage } : null;
}

export function stampTrustedUserPromotion(args: Record<string, unknown>, request: MemoryPromotionRequest, evidence: { userMessage: string; evidenceSpan: string }): void {
  const capability = createUserEvidenceCapability({ ...request, ...evidence });
  Object.defineProperty(args, CAPABILITY, { value: capability, enumerable: false });
}

// Turn-level guard for silent model self-save. The session-level taint flag
// (hasExternalIngestion) is sticky across the whole session, but a single turn
// can carry untrusted content BEFORE that flag is set — an external-marker
// wrapper injected into the user span or into a tool result the model may now
// be paraphrasing. Scan the whole current turn (user span + everything after
// it) for the markers; a clean local tool result does NOT block the save —
// on a clean session there is no off-box content to launder.
export function cleanTurnForModelSelfSave(priorMessages: unknown[] | undefined): boolean {
  const turn = currentUserTurn(priorMessages);
  return !UNTRUSTED_MARKERS.test(turn.text) && !UNTRUSTED_MARKERS.test(turn.turnTail);
}

export const CLEAN_SELF_SOURCE_SUFFIX = ":clean-self";

// A clean session (no external ingestion this turn) is the only place the model
// may promote its OWN reasoning without a human click — there is no untrusted
// off-box content that could be laundered into the saved text. The distinct
// `:clean-self` source suffix keeps the audit trail honest: this was
// auto-allowed on a clean session, NOT human-approved.
export function stampCleanModelPromotion(args: Record<string, unknown>, request: MemoryPromotionRequest): void {
  const capability = mint({ ...request, source: `${request.source}${CLEAN_SELF_SOURCE_SUFFIX}`, origin: "assistant" });
  Object.defineProperty(args, CAPABILITY, { value: capability, enumerable: false });
}

export function stampApprovedMemoryPromotion(args: Record<string, unknown>, request: MemoryPromotionRequest, grantId: string): void {
  const capability = mint({ ...request, source: `${request.source}:approval:${grantId}`, origin: "assistant" });
  Object.defineProperty(args, CAPABILITY, { value: capability, enumerable: false });
}

export const TAINTED_SOURCE_SUFFIX = ":tainted-external";

// Only the Facts DB can carry per-row provenance to recall time, so only
// fact-DB targets are eligible for the silent tainted-write path. Profile
// files / project briefs / the daily log render under trust labels that
// per-item provenance cannot correct — a tainted write there WOULD launder,
// so those targets stay on interactive approval.
export function isFactDbPromotion(request: MemoryPromotionRequest): boolean {
  return request.target === "memory:retain" || request.target.startsWith("memory:update:");
}

// Flood guard for the silent tainted-write path: an injected page that tells
// the model to spam `remember` gets a hard per-session ceiling instead of an
// unbounded write channel. Dedupe in retain() already rejects exact repeats;
// this bounds distinct junk. In-memory and session-lifetime, like the
// ingestion mark itself.
export const TAINTED_PROMOTION_QUOTA = 25;
const taintedWriteCounts = new Map<string, number>();

export function taintedPromotionQuotaExhausted(sessionId: string): boolean {
  return (taintedWriteCounts.get(sessionId) ?? 0) >= TAINTED_PROMOTION_QUOTA;
}

/** Test hook — quota state is per-session and process-lifetime, like clearExternalIngestion. */
export function clearTaintedPromotionQuota(sessionId: string): void {
  taintedWriteCounts.delete(sessionId);
}

// A promotion from a session that has ingested off-box content proceeds
// WITHOUT a human click — but permanently second-class: the `:tainted-external`
// source suffix survives into the persisted fact's source_file, and recall
// renders it under an untrusted label (fact-provenance-label.ts). The
// invariant this preserves: content never GAINS trust by passing through
// memory — a web-tainted save is recalled no more trusted than the page it
// may have been laundered from, so there is no trust promotion for a human
// to gate.
export function stampTaintedModelPromotion(args: Record<string, unknown>, request: MemoryPromotionRequest): void {
  const capability = mint({ ...request, source: `${request.source}${TAINTED_SOURCE_SUFFIX}`, origin: "assistant" });
  Object.defineProperty(args, CAPABILITY, { value: capability, enumerable: false });
  taintedWriteCounts.set(request.sessionId, (taintedWriteCounts.get(request.sessionId) ?? 0) + 1);
}

export function promotionContextFromToolArgs(args: Record<string, unknown>, request: {
  content: string; target: string; source: string; sessionId?: string; provenance?: string; confidence?: number;
}): MemoryPromotionContext {
  const capability = (args as Record<PropertyKey, unknown>)[CAPABILITY] as MemoryPromotionCapability | undefined;
  const state = capability ? states.get(capability) : undefined;
  return {
    ...request,
    origin: state?.claims.origin ?? "unknown",
    capability,
    evidenceContent: request.content,
    source: state?.claims.source ?? request.source,
    provenance: state?.claims.provenance ?? request.provenance ?? "unknown",
    confidence: state?.claims.confidence ?? request.confidence ?? 0,
  };
}

export function assertMemoryPromotionAllowed(content: string, target: string, context?: MemoryPromotionContext, consume = true): void {
  assertMemoryPromotionCapability(context?.capability, {
    content: context?.evidenceContent ?? content,
    target: context?.target ?? target,
    source: context?.source ?? "unknown",
    sessionId: context?.sessionId ?? "default",
    provenance: context?.provenance ?? "unknown",
    confidence: context?.confidence ?? 0,
    origin: context?.origin ?? "unknown",
  }, consume);
}

export function _resetMemoryPromotionApprovals(): void { /* WeakMap state is per-capability. */ }
