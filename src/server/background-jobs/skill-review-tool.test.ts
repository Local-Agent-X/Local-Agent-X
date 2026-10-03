// The review fork reads the catalog through the live `protocol` family, and
// those reads must not count as use: getProtocolStats feeds the unattended
// archive sweep and the prune report, so a fork read that counted kept
// agent-written notes looking used. protocol_get tells a maintenance read by
// the trusted `_operationId`, and protocol_search files its record under the
// trusted `_sessionId`. Dispatch stamps both flat, and the family drops every
// `_` key from the model's `params`. The fork once folded the stamps into
// `params` before handing the call on, so neither arrived. These tests run the
// whole seam: dispatch, the narrowed tool, the real collapsed family and the
// real protocol actions, with only the op store and the usage log stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SecurityLayer } from "../../security/index.js";
import type { UsageRecord } from "../../protocols/usage.js";

const { recordUsage, OP_TYPES } = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  OP_TYPES: { op_skill_review_1: "skill_review", op_chat_turn_1: "chat_turn" } as Record<string, string>,
}));

vi.mock("../../ops/op-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ops/op-store.js")>()),
  readOp: (id: string) => (OP_TYPES[id] ? { id, type: OP_TYPES[id] } : null),
}));
vi.mock("../../protocols/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../protocols/usage.js")>()),
  recordUsage,
}));

import { createContext } from "../../tool-execution/context.js";
import { resolvePhase } from "../../tool-execution/resolve-tool.js";
import { createProtocolFamilyTools } from "../../protocols/protocol-tool.js";
import { narrowProtocolToolForReview } from "./skill-review-tool.js";

const FORK_SESSION = "skill-review-fork";

async function dispatched(args: Record<string, unknown>, operationId: string, sessionId = FORK_SESSION): Promise<Record<string, unknown>> {
  const ctx = createContext({
    tc: { id: "call-protocol", name: "protocol", arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId,
    operationId,
    callContext: "local",
  });
  expect((await resolvePhase(ctx)).kind).toBe("continue");
  return ctx.args;
}

const family = () => createProtocolFamilyTools()[0];
const reviewTool = () => narrowProtocolToolForReview(family(), { reviewedSessionId: "reviewed-session", toolSequence: [] });
const recorded = (action: UsageRecord["action"]) =>
  recordUsage.mock.calls.map(([rec]) => rec as UsageRecord).filter((rec) => rec.action === action);

beforeEach(() => recordUsage.mockClear());

describe("the review fork's catalog reads through the live protocol family", () => {
  it("a chat turn's get counts as use, under its session", async () => {
    const args = await dispatched({ action: "get", params: { name: "wrangler" } }, "op_chat_turn_1", "chat-session");
    const result = await family().execute(args);
    expect(String(result.content)).toContain("# Protocol: wrangler");
    expect(recorded("invoked")).toEqual([expect.objectContaining({ name: "wrangler", sessionId: "chat-session" })]);
  });

  it("the fork's get reads the protocol and does not count as use", async () => {
    const args = await dispatched({ action: "get", params: { name: "wrangler" } }, "op_skill_review_1");
    const result = await reviewTool().execute(args);
    expect(String(result.content)).toContain("# Protocol: wrangler");
    expect(recorded("invoked")).toEqual([]);
  });

  it("the fork's model cannot name a person's op to make its get count", async () => {
    const args = await dispatched({ action: "get", params: { name: "wrangler", _operationId: "op_chat_turn_1" } }, "op_skill_review_1");
    await reviewTool().execute(args);
    expect(recorded("invoked")).toEqual([]);
  });

  it("the fork's search is filed under the fork's session, not one its model names", async () => {
    const args = await dispatched({ action: "search", params: { query: "wrangler", _sessionId: "someone-else" } }, "op_skill_review_1");
    const result = await reviewTool().execute(args);
    expect(result.isError).toBeFalsy();
    expect(recorded("searched")).toEqual([expect.objectContaining({ query: "wrangler", sessionId: FORK_SESSION })]);
  });
});
