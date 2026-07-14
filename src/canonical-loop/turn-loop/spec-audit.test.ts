import { describe, it, expect, beforeEach, vi } from "vitest";

// The gate anchors to the op's first user message; ops in this test have no
// on-disk message store, so pin the request text here.
vi.mock("../store.js", () => ({
  firstUserMessageText: vi.fn(() => "Remove every tailnet reference from the app"),
  appliedRedirectTexts: vi.fn(() => []),
}));

import { firstUserMessageText, appliedRedirectTexts } from "../store.js";
import { runSpecAuditGate, clearSpecAuditStateForOp, _resetSpecAuditState } from "./spec-audit.js";
import type { Op } from "../../ops/types.js";

const op = (id: string) => ({ id } as Op);
const PATHS = ["/proj/app/errors.ts"];
const DIFF = "diff --git a/errors.ts b/errors.ts\n- tailnet\n+ desktop";

const evidenceOk = vi.fn(async () => DIFF);
const auditWith = (verdict: string[] | null) => vi.fn(async () => verdict);

beforeEach(() => {
  _resetSpecAuditState();
  vi.clearAllMocks();
  (firstUserMessageText as ReturnType<typeof vi.fn>).mockReturnValue(
    "Remove every tailnet reference from the app",
  );
  (appliedRedirectTexts as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

describe("runSpecAuditGate", () => {
  it("unmet findings → one retry nudge naming the items", async () => {
    const audit = auditWith(['"remove every tailnet ref" — errors.ts still shows "Tailscale network"']);
    const r = await runSpecAuditGate(op("a"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("Tailscale network");
    expect(r.nudge).toContain("fresh eyes");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("fires at most once per op — the re-claimed done is not re-audited", async () => {
    const audit = auditWith(["item"]);
    await runSpecAuditGate(op("b"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    const second = await runSpecAuditGate(op("b"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(second.shouldRetry).toBe(false);
    expect(audit).toHaveBeenCalledOnce();
  });

  it("an all-met verdict is a no-op and still consumes the op's one audit", async () => {
    const audit = auditWith([]);
    const r = await runSpecAuditGate(op("c"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(false);
    await runSpecAuditGate(op("c"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(audit).toHaveBeenCalledOnce();
  });

  it("a null verdict (classifier down / unparseable) degrades to a no-op, never a nudge", async () => {
    const audit = auditWith(null);
    const r = await runSpecAuditGate(op("d"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
  });

  it("no edited paths / too-short request → no-op before any evidence or LLM work", async () => {
    const audit = auditWith(["item"]);
    const r1 = await runSpecAuditGate(op("e"), { editedPaths: [], collectEvidence: evidenceOk, audit });
    expect(r1.shouldRetry).toBe(false);
    (firstUserMessageText as ReturnType<typeof vi.fn>).mockReturnValue("fix");
    const r2 = await runSpecAuditGate(op("f"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r2.shouldRetry).toBe(false);
    expect(evidenceOk).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("empty/failed evidence is a no-op that does NOT consume the audit (transient git failure)", async () => {
    const audit = auditWith(["item"]);
    const empty = vi.fn(async () => "");
    const r = await runSpecAuditGate(op("g"), { editedPaths: PATHS, collectEvidence: empty, audit });
    expect(r.shouldRetry).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    // evidence recovers → the audit still gets its one shot
    const r2 = await runSpecAuditGate(op("g"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r2.shouldRetry).toBe(true);
    // a throwing collector is equally safe
    const boom = vi.fn(async () => { throw new Error("git exploded"); });
    const r3 = await runSpecAuditGate(op("h"), { editedPaths: PATHS, collectEvidence: boom, audit });
    expect(r3.shouldRetry).toBe(false);
  });

  it("clearSpecAuditStateForOp re-arms the op", async () => {
    const audit = auditWith(["item"]);
    await runSpecAuditGate(op("i"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    clearSpecAuditStateForOp("i");
    const r = await runSpecAuditGate(op("i"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(true);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("applied redirect instructions are audited as amendments to the request", async () => {
    // 2026-07-13: "make sure its not dark theme" arrived as a redirect, was
    // consumed, and vanished — the audit re-read only the opening prompt and
    // returned MET on a worker that never made the edit. Amendments must be
    // part of the audited request.
    (appliedRedirectTexts as ReturnType<typeof vi.fn>).mockReturnValue([
      "make sure its not dark theme",
      "give it a custom background",
    ]);
    const audit = auditWith([]);
    await runSpecAuditGate(op("j"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    const { userRequest } = (audit.mock.calls[0] as unknown as [{ userRequest: string }])[0];
    expect(userRequest).toContain("Remove every tailnet reference");
    expect(userRequest).toContain("Mid-build user amendments");
    expect(userRequest).toContain("1. make sure its not dark theme");
    expect(userRequest).toContain("2. give it a custom background");
  });

  it("no applied redirects → the audited request is the first message alone", async () => {
    const audit = auditWith([]);
    await runSpecAuditGate(op("k"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    const { userRequest } = (audit.mock.calls[0] as unknown as [{ userRequest: string }])[0];
    expect(userRequest).toBe("Remove every tailnet reference from the app");
    expect(userRequest).not.toContain("amendments");
  });
});
