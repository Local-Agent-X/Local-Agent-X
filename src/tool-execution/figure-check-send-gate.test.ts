// A deliverable whose figures are still being checked, or did not match and
// were not corrected, does not leave without the user's yes: once sent, a
// later correction cannot reach it (2026-11-24). The gate asks; it never
// refuses (an unattended run is parked by the approval phase, not here).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ files: new Map<string, string>(), sends: true, attached: [] as string[] }));
vi.mock("../canonical-loop/public/verification-pass.js", () => ({
  figureCheckOf: (p: string) => state.files.get(p) ?? null,
}));
vi.mock("./private-content-destinations.js", () => ({ sendsOffBox: () => state.sends }));
vi.mock("./egress-payload.js", () => ({ egressPayload: () => ({ text: "", attachmentPaths: state.attached }) }));
vi.mock("../workspace/paths.js", () => ({ resolveAgentPath: (p: string) => p }));

import { figureCheckSendGate } from "./figure-check-send-gate.js";

const deck = join(tmpdir(), "q3-market.pptx");
const sheet = join(tmpdir(), "prices.xlsx");
const call = () => ({ tc: { name: "email_send", id: "c1" }, args: {}, sessionId: "s1", policyApprovalReason: undefined as string | undefined });

beforeEach(() => { state.files.clear(); state.sends = true; state.attached = [deck]; });

describe("a send attaching a deliverable", () => {
  it("asks while the deck's figures are still being checked", () => {
    state.files.set(deck, "checking");
    const ctx = call();
    figureCheckSendGate(ctx as never);
    expect(ctx.policyApprovalReason).toBe("Send it anyway? The figures in q3-market.pptx are still being checked against their sources. Once it is sent, a later correction cannot reach the copy that went out.");
  });

  it("asks when its figures don't match and weren't corrected, naming each file", () => {
    state.attached = [deck, sheet];
    state.files.set(deck, "correcting");
    state.files.set(sheet, "mismatch");
    const ctx = call();
    figureCheckSendGate(ctx as never);
    expect(ctx.policyApprovalReason).toContain("The figures in q3-market.pptx are still being checked");
    expect(ctx.policyApprovalReason).toContain("prices.xlsx has figures that don't match their sources and weren't corrected");
  });

  it.each(["confirmed", "corrected", "unchecked"])("goes ahead when its check ended %s", (s) => {
    state.files.set(deck, s);
    const ctx = call();
    figureCheckSendGate(ctx as never);
    expect(ctx.policyApprovalReason).toBeUndefined();
  });

  it("goes ahead for a file never checked, and for a call that is not a send", () => {
    const ctx = call();
    figureCheckSendGate(ctx as never);
    expect(ctx.policyApprovalReason).toBeUndefined();
    state.files.set(deck, "checking");
    state.sends = false;
    figureCheckSendGate(ctx as never);
    expect(ctx.policyApprovalReason).toBeUndefined();
  });
});
