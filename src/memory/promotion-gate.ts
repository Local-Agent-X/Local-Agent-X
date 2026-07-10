import { createHash } from "node:crypto";

export type MemoryContentOrigin =
  | "user_statement"
  | "assistant"
  | "tool_observation"
  | "external"
  | "import"
  | "unknown"
  | "durable_memory";

export interface MemoryPromotionApproval {
  grantId: string;
  sessionId: string;
  source: string;
  target: string;
  contentHash: string;
}

export interface MemoryPromotionContext {
  origin: MemoryContentOrigin;
  sessionId?: string;
  source?: string;
  target?: string;
  evidenceContent?: string;
  approval?: MemoryPromotionApproval;
}

export interface MemoryPromotionRequest {
  source: string;
  target: string;
  content: string;
  sessionId: string;
}

const APPROVAL = Symbol("memory-promotion-approval");
const consumedGrants = new Set<string>();

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function describeMemoryPromotionRequest(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string,
): MemoryPromotionRequest | null {
  let content = "";
  let target = "";
  switch (toolName) {
    case "remember":
      content = String(args.content || "").trim();
      target = "memory:retain";
      break;
    case "update_fact":
      content = String(args.content || "").trim();
      target = `memory:update:${String(args.query || "").trim()}`;
      break;
    case "memory_save":
      content = String(args.content || "");
      target = "memory:daily-log";
      break;
    case "memory_set_user_field":
      content = `${String(args.field || "").trim()}: ${String(args.value || "").trim()}`;
      target = "memory:profile:user-field";
      break;
    case "memory_update_profile":
      content = String(args.content || "");
      target = `memory:profile:${String(args.file || "unknown")}`;
      break;
    case "project_brief_update":
      content = String(args.content || "").trim();
      target = "memory:project-brief";
      break;
    case "project_create":
      content = String(args.summary || "").trim();
      target = "memory:project-brief";
      break;
    default:
      return null;
  }
  if (!content.trim()) return null;
  return { content, target, sessionId, source: `model-tool:${toolName}` };
}

export function stampMemoryPromotionApproval(
  args: Record<string, unknown>,
  request: MemoryPromotionRequest,
  grantId: string,
): void {
  Object.defineProperty(args, APPROVAL, {
    value: {
      grantId,
      sessionId: request.sessionId,
      source: request.source,
      target: request.target,
      contentHash: hash(request.content),
    } satisfies MemoryPromotionApproval,
    enumerable: false,
  });
}

export function promotionContextFromToolArgs(
  args: Record<string, unknown>,
  request: {
    source: string;
    target: string;
    content: string;
    sessionId?: string;
  },
): MemoryPromotionContext {
  return {
    origin: "assistant",
    sessionId: request.sessionId,
    source: request.source,
    target: request.target,
    evidenceContent: request.content,
    approval: (args as Record<PropertyKey, unknown>)[APPROVAL] as MemoryPromotionApproval | undefined,
  };
}

export function assertMemoryPromotionAllowed(
  content: string,
  target: string,
  context?: MemoryPromotionContext,
): void {
  const origin = context?.origin ?? "unknown";
  if (origin === "user_statement" || origin === "durable_memory") return;

  const approval = context?.approval;
  const evidence = context?.evidenceContent ?? content;
  const matches = approval
    && approval.sessionId === context?.sessionId
    && approval.source === context?.source
    && approval.target === (context?.target ?? target)
    && approval.contentHash === hash(evidence);
  if (!matches) {
    throw new Error(`explicit user approval required for ${origin} memory promotion`);
  }
  if (consumedGrants.has(approval.grantId)) {
    throw new Error("memory promotion approval has already been consumed");
  }
  consumedGrants.add(approval.grantId);
}

/** Test isolation only. */
export function _resetMemoryPromotionApprovals(): void {
  consumedGrants.clear();
}
