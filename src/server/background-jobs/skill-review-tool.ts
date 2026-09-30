/**
 * The review fork's `protocol` tool: the collapsed family narrowed to three
 * reads plus `propose`, which drafts a learned procedure and never touches the
 * live catalog.
 *
 * D20 still governs: a tool's execute(args) has no trustworthy channel for
 * provenance, so the reviewed session and its tool evidence come from
 * EXECUTION CONTEXT (this wrapper exists only because a review fork built it),
 * never from model arguments. The one judgement the model supplies is
 * `outcome`, and it can only lower what a proposal counts for: "corrected" can
 * never start a procedure and never counts as evidence.
 */
import type { ToolDefinition, ToolResult } from "../../types.js";
import type { LearningNotice } from "../../protocols/learned-review-drafting.js";
import { REVIEW_PROTOCOL_ACTIONS } from "./skill-review-prompt.js";
import { LEARNED_KNOWLEDGE_KINDS, type LearnedKnowledge } from "../../protocols/learned-proposal-gate.js";
import { MAX_GAP_SUMMARY_CHARS, MAX_GAP_TOOLS } from "../../cognition/cross-session-learning/capability-gaps.js";

const LEARNED_SLUG = /^learned-[a-f0-9]{20}$/;

const REVIEW_PROTOCOL_DESCRIPTION = `Read the protocol catalog and propose learned procedures.

Actions:
• search(query): find protocols, and learned procedures earlier reviews proposed, matching a query. Start here.
• list(): every live protocol with its triggers, plus the pending learned procedures.
• get(name): a protocol's or learned procedure's full body. Read one before proposing a new version of it.
• propose(name, description, triggers, body, outcome, learned): propose a learned procedure as a DRAFT the user reviews. Use an existing learned procedure's name (or learned-… id) to add evidence and a new version instead of a near-duplicate. outcome is "verified" (a check passed, or the user confirmed or kept building on it) or "corrected" (the user reverted or corrected the run — only allowed for an existing learned procedure). learned is {kind, detail}: kind is one of ${LEARNED_KNOWLEDGE_KINDS.join(", ")}, and detail quotes, verbatim from the body, the one thing the agent could not have derived from its tools and the repo. No such thing means nothing to propose.
• note_gap(summary, tools_tried, workaround): record that a native tool fell short and the run had to work around it. This is NOT a procedure — it goes to the maintainer's capability-gap log, never to the catalog. Use it instead of propose whenever the "procedure" is "call tool X, and when it misses, do Y".`;

export interface ReviewProtocolToolContext {
  /** The session whose turn is under review — the proposal's provenance. */
  reviewedSessionId: string;
  /** Tools the reviewed op actually called — the draft's capability evidence. */
  toolSequence: readonly string[];
  /** Projects the reviewed op worked in, from the paths its calls named. */
  projectNames?: readonly string[];
  /** Tell the reviewed session a draft is waiting on the user. */
  onProposed?: (sessionId: string, notice: LearningNotice) => void;
}

function mergeFamilyArgs(args: Record<string, unknown>): { action: string; inner: Record<string, unknown> } {
  const { action, params, ...rest } = args;
  const nested = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : undefined;
  return { action: String(action ?? ""), inner: nested ? { ...rest, ...nested } : rest };
}

function refuse(content: string): ToolResult {
  return { content, isError: true };
}

/** The model's `learned` argument as the gate's input shape; the gate itself
 *  decides whether the kind and detail hold up. */
function learnedFrom(value: unknown): LearnedKnowledge | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return { kind: String(record.kind ?? "") as LearnedKnowledge["kind"], detail: String(record.detail ?? "") };
}

async function noteGapForReview(inner: Record<string, unknown>, ctx: ReviewProtocolToolContext): Promise<ToolResult> {
  const summary = typeof inner.summary === "string" ? inner.summary.replace(/\s+/g, " ").trim().slice(0, MAX_GAP_SUMMARY_CHARS) : "";
  if (!summary) return refuse("note_gap needs a one-line `summary` of what the agent needed and could not do natively.");
  const toolsTried = (Array.isArray(inner.tools_tried) ? inner.tools_tried : [])
    .map(String).filter((tool) => /^[a-z][a-z0-9_]*$/.test(tool)).slice(0, MAX_GAP_TOOLS);
  const workaround = typeof inner.workaround === "string" ? inner.workaround.replace(/\s+/g, " ").trim().slice(0, MAX_GAP_SUMMARY_CHARS) : "";
  const { appendCapabilityGap } = await import("../../cognition/cross-session-learning/capability-gaps.js");
  appendCapabilityGap({
    sessionId: ctx.reviewedSessionId,
    timestamp: Date.now(),
    summary,
    toolsTried,
    ...(workaround ? { workaround } : {}),
  });
  return { content: `Recorded a capability gap: ${summary}. It is logged for the maintainer and is not a procedure.` };
}

async function getForReview(base: ToolDefinition, inner: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const name = typeof inner.name === "string" ? inner.name.trim() : "";
  if (!name) return refuse("get needs the `name` of a protocol or learned procedure.");
  const { describeLearnedProcedure } = await import("../../protocols/learned-review-drafting.js");
  const direct = describeLearnedProcedure(name);
  if (direct) return { content: direct };
  const { findProtocol } = await import("../../protocols/index.js");
  const hit = findProtocol(name);
  if (hit && LEARNED_SLUG.test(hit.name)) {
    const learned = describeLearnedProcedure(hit.name);
    return learned ? { content: learned } : refuse(`"${hit.name}" could not be read.`);
  }
  return base.execute({ action: "get", params: inner }, signal);
}

async function withPendingProcedures(result: ToolResult, query?: string): Promise<ToolResult> {
  if (result.isError) return result;
  const { pendingProcedureCatalog } = await import("../../protocols/learned-review-drafting.js");
  return { ...result, content: `${result.content}${pendingProcedureCatalog(query)}` };
}

async function proposeForReview(inner: Record<string, unknown>, ctx: ReviewProtocolToolContext): Promise<ToolResult> {
  const outcome = inner.outcome;
  if (outcome !== "verified" && outcome !== "corrected") {
    return refuse("propose needs `outcome`: \"verified\" or \"corrected\". If the run neither passed a check nor was confirmed by the user, do not propose.");
  }
  const name = typeof inner.name === "string" ? inner.name : "";
  const description = typeof inner.description === "string" ? inner.description : "";
  if (!name.trim() || !description.trim()) return refuse("propose needs both `name` and `description`.");
  try {
    const { proposeReviewedProcedure } = await import("../../protocols/learned-review-drafting.js");
    const result = proposeReviewedProcedure({
      name,
      description,
      triggers: Array.isArray(inner.triggers) ? (inner.triggers as unknown[]).map(String) : [],
      body: typeof inner.body === "string" ? inner.body : "",
      outcome,
      origin: "review",
      learned: learnedFrom(inner.learned),
      projectNames: ctx.projectNames ?? [],
      sessionId: ctx.reviewedSessionId,
      toolSequence: ctx.toolSequence,
    });
    if (!result.ok) return refuse(result.message);
    if (result.notice) ctx.onProposed?.(ctx.reviewedSessionId, result.notice);
    const what = result.created ? "Proposed new learned procedure" : "Recorded this conversation as evidence for";
    const version = result.drafted ? " with a new draft version" : "";
    return { content: `${what} "${result.name}" (${result.candidateId})${version}. It stays a draft until the user keeps it or other conversations confirm it.` };
  } catch (e) {
    return refuse((e as Error).message);
  }
}

export function narrowProtocolToolForReview(base: ToolDefinition, ctx: ReviewProtocolToolContext): ToolDefinition {
  const allowed = new Set<string>(REVIEW_PROTOCOL_ACTIONS);
  return {
    name: base.name,
    description: REVIEW_PROTOCOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...REVIEW_PROTOCOL_ACTIONS], description: "Which operation to run — see the per-action docs in the tool description." },
        params: { type: "object", description: "Arguments for the chosen action." },
      },
      required: ["action"],
    },
    async execute(args, signal): Promise<ToolResult> {
      const { action, inner } = mergeFamilyArgs(args);
      if (!allowed.has(action)) {
        return refuse(`Action "${action}" is not available to the protocol review pass. Allowed: ${REVIEW_PROTOCOL_ACTIONS.join(", ")}.`);
      }
      if (action === "propose") return proposeForReview(inner, ctx);
      if (action === "note_gap") return noteGapForReview(inner, ctx);
      if (action === "get") return getForReview(base, inner, signal);
      const query = action === "search" && typeof inner.query === "string" ? inner.query : undefined;
      return withPendingProcedures(await base.execute({ action, params: inner }, signal), query);
    },
  };
}
