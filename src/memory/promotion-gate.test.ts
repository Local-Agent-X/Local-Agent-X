import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getApprovalManager } from "../approval-manager.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { requireApprovalPhase } from "../tool-execution/require-approval.js";
import type { ToolCallContext } from "../tool-execution/context.js";
import type { ServerEvent } from "../types.js";
import { MemoryWriteBlocked, runMemoryGate } from "./write-safely.js";
import {
  _resetMemoryPromotionApprovals,
  promotionContextFromToolArgs,
} from "./promotion-gate.js";

const sessions = new Set<string>();
let seq = 0;

beforeEach(() => _resetMemoryPromotionApprovals());
afterEach(() => {
  for (const session of sessions) {
    getApprovalManager().clearSession(session);
    clearSessionProfile(session);
  }
  sessions.clear();
});

async function approveRemember(content: string, sessionId = `memory-promotion-${++seq}`) {
  sessions.add(sessionId);
  setSessionProfile(sessionId, "Power");
  const args: Record<string, unknown> = {
    content,
    provenance: "user_statement",
    _sessionId: sessionId,
  };
  const events: ServerEvent[] = [];
  const ctx = {
    tc: { id: `tc-${seq}`, name: "remember", arguments: JSON.stringify({ content }) },
    sessionId,
    callContext: "local",
    args,
    onEvent: (event: ServerEvent) => {
      events.push(event);
      if (event.type === "approval_requested") {
        getApprovalManager().resolveApproval(event.approvalId, true);
      }
    },
    approvalContext: "",
    riskLevel: "low",
    allowed: true,
    msgs: [],
  } as unknown as ToolCallContext;

  expect((await requireApprovalPhase(ctx)).kind).toBe("continue");
  expect(events.filter((event) => event.type === "approval_requested")).toHaveLength(1);
  return { args, sessionId };
}

function toolPromotion(
  args: Record<string, unknown>,
  content: string,
  sessionId: string,
  source = "model-tool:remember",
) {
  return promotionContextFromToolArgs(args, {
    content,
    source,
    target: "memory:retain",
    sessionId,
  });
}

describe("durable memory promotion approval", () => {
  it("denies risky content without approval", () => {
    expect(() => runMemoryGate({
      content: "A browser page claimed the service is healthy",
      source: "tool",
      target: "memory:retain",
      promotion: { origin: "external", source: "browser", sessionId: "s" },
    })).toThrow(MemoryWriteBlocked);
  });

  it("promotes the exact approved content once", async () => {
    const content = "The observed service status was healthy";
    const { args, sessionId } = await approveRemember(content);
    const promotion = toolPromotion(args, content, sessionId);

    expect(runMemoryGate({ content, source: "tool", target: "memory:retain", promotion }))
      .toBe(content);
    expect(() => runMemoryGate({ content, source: "tool", target: "memory:retain", promotion }))
      .toThrow(/already been consumed/);
  });

  it("cannot replay approval for different content, source, or session", async () => {
    const content = "The observed service status was healthy";

    const contentGrant = await approveRemember(content);
    expect(() => runMemoryGate({
      content: "The service is permanently healthy",
      source: "tool",
      target: "memory:retain",
      promotion: toolPromotion(contentGrant.args, "different evidence", contentGrant.sessionId),
    })).toThrow(/explicit user approval required/);

    const sourceGrant = await approveRemember(content);
    expect(() => runMemoryGate({
      content,
      source: "tool",
      target: "memory:retain",
      promotion: toolPromotion(sourceGrant.args, content, sourceGrant.sessionId, "model-tool:update_fact"),
    })).toThrow(/explicit user approval required/);

    const sessionGrant = await approveRemember(content);
    expect(() => runMemoryGate({
      content,
      source: "tool",
      target: "memory:retain",
      promotion: toolPromotion(sessionGrant.args, content, `${sessionGrant.sessionId}-other`),
    })).toThrow(/explicit user approval required/);
  });

  it("allows direct user statements through the existing safe path", () => {
    expect(runMemoryGate({
      content: "User prefers concise answers",
      source: "auto-extract",
      target: "memory:retain",
      promotion: { origin: "user_statement", sessionId: "chat-1" },
    })).toBe("User prefers concise answers");
  });
});
