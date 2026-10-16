// The user's yes to one exact call, given from the inbox, is single-use, keyed
// to that call in that session, and answers any card raised for it, alwaysAsk
// included.
import { describe, expect, it, vi } from "vitest";
import { CallGrants } from "./approval-call-grants.js";
import { getApprovalManager } from "./approval-manager.js";

describe("CallGrants", () => {
  it("is taken once, for exactly that call in that session, whatever internal args the dispatcher added", () => {
    const grants = new CallGrants();
    const id = grants.grant("s1", "bash", { command: "npm publish" });
    expect(grants.take("s2", "bash", { command: "npm publish" })).toBeNull();
    expect(grants.take("s1", "bash", { command: "npm publish --tag next" })).toBeNull();
    expect(grants.take("s1", "bash", { command: "npm publish", _sessionId: "s1" })).toBe(id);
    expect(grants.take("s1", "bash", { command: "npm publish" })).toBeNull();
  });

  it("revoke drops an unconsumed grant", () => {
    const grants = new CallGrants();
    const id = grants.grant("s1", "write", { path: "a.md", content: "x" });
    grants.revoke(id);
    expect(grants.size()).toBe(0);
    expect(grants.take("s1", "write", { path: "a.md", content: "x" })).toBeNull();
  });
});

describe("ApprovalManager with a one-shot grant", () => {
  it("answers the first card for that exact call, even an alwaysAsk one, without showing it; the next one asks", async () => {
    const mgr = getApprovalManager();
    const emit = vi.fn();
    const ask = { toolName: "bash", toolCallId: "t1", sessionId: "grant-s1", context: "", args: { command: "rm -rf build" }, alwaysAsk: true, emit };
    const id = mgr.callGrants.grant("grant-s1", "bash", { command: "rm -rf build" });
    expect(await mgr.requestApprovalDetailed(ask)).toEqual({ approved: true, grantId: id });
    expect(emit).not.toHaveBeenCalled();

    const second = mgr.requestApprovalDetailed({ ...ask, toolCallId: "t2" });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "approval_requested" }));
    mgr.clearSession("grant-s1");
    expect(await second).toMatchObject({ approved: false });
  });
});
