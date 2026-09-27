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

const LEARNED_SLUG = /^learned-[a-f0-9]{20}$/;

const REVIEW_PROTOCOL_DESCRIPTION = `Read the protocol catalog and propose learned procedures.

Actions:
• search(query): find protocols, and learned procedures earlier reviews proposed, matching a query. Start here.
• list(): every live protocol with its triggers, plus the pending learned procedures.
• get(name): a protocol's or learned procedure's full body. Read one before proposing a new version of it.
• propose(name, description, triggers, body, outcome): propose a learned procedure as a DRAFT the user reviews. Use an existing learned procedure's name (or learned-… id) to add evidence and a new version instead of a near-duplicate. outcome is "verified" (a check passed, or the user confirmed or kept building on it) or "corrected" (the user reverted or corrected the run — only allowed for an existing learned procedure).`;

export interface ReviewProtocolToolContext {
  /** The session whose turn is under review — the proposal's provenance. */
  reviewedSessionId: string;
  /** Tools the reviewed op actually called — the draft's capability evidence. */
  toolSequence: readonly string[];
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
      if (action === "get") return getForReview(base, inner, signal);
      const query = action === "search" && typeof inner.query === "string" ? inner.query : undefined;
      return withPendingProcedures(await base.execute({ action, params: inner }, signal), query);
    },
  };
}
