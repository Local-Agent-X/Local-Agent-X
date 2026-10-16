import { describe, it, expect, vi, beforeEach } from "vitest";

// Egress-refutation pack — autonomous safety net for high-stakes irreversible
// egress. Mock ONLY verifyByRefutation so the verdict is deterministic; the
// egress classification (hasCapability) and each row's destination run for
// real against the real tool names (email_send is egress + a message to its
// recipients, web_search is egress but not high-stakes).

const verifyByRefutation = vi.fn();

vi.mock("../../src/classifiers/verify-by-refutation.js", () => ({
  verifyByRefutation: (args: unknown) => verifyByRefutation(args),
}));

import { makeEgressRefutationPack } from "../../src/tool-policy/packs/egress-refutation-pack.js";

const EMAIL_CALL = { id: "t1", name: "email_send", args: { to: "a@b.com", body: "hi" } };
const SEARCH_CALL = { id: "t2", name: "web_search", args: { query: "weather" } };

const LOCAL = { sessionId: "s1", callContext: "local" as const };
const CRON = { sessionId: "s1", callContext: "cron" as const };

function mockVerdict(verdict: "refuted" | "holds" | "inconclusive") {
  verifyByRefutation.mockResolvedValue({
    verdict,
    refutedCount: verdict === "refuted" ? 2 : 0,
    holdsCount: verdict === "holds" ? 2 : 0,
    nullCount: verdict === "inconclusive" ? 3 : 0,
    voters: 3,
  });
}

describe("egress-refutation pack", () => {
  beforeEach(() => {
    verifyByRefutation.mockReset();
  });

  it("allows in an interactive (local) session without running the refutation", async () => {
    const decision = await makeEgressRefutationPack().evaluate(EMAIL_CALL, LOCAL);
    expect(decision.allowed).toBe(true);
    expect(verifyByRefutation).not.toHaveBeenCalled();
  });

  it("passes through a non-high-stakes egress tool (web_search) without running the refutation", async () => {
    const decision = await makeEgressRefutationPack().evaluate(SEARCH_CALL, CRON);
    expect(decision.allowed).toBe(true);
    expect(verifyByRefutation).not.toHaveBeenCalled();
  });

  it("a message to a person is high-stakes by its row's destination; the clipboard is not", async () => {
    mockVerdict("holds");
    for (const [name, args] of [
      ["telegram_send", { text: "hi" }], ["whatsapp_send", { phone: "+15550100", text: "hi" }],
      ["send_image", { path: "a.png" }], ["send_video", { path: "a.mp4" }], ["send_file", { path: "a.pdf" }],
    ] as const) {
      verifyByRefutation.mockClear();
      await makeEgressRefutationPack().evaluate({ id: "t", name, args }, CRON);
      expect(verifyByRefutation, name).toHaveBeenCalledTimes(1);
    }
    verifyByRefutation.mockClear();
    await makeEgressRefutationPack().evaluate({ id: "t", name: "clipboard_write", args: { text: "hi" } }, CRON);
    expect(verifyByRefutation).not.toHaveBeenCalled();
  });

  it("denies an autonomous high-stakes send when a majority refutes it", async () => {
    mockVerdict("refuted");
    const decision = await makeEgressRefutationPack().evaluate(EMAIL_CALL, CRON);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("majority of safety reviewers");
      expect(decision.recovery).toContain("LAX_EGRESS_REFUTE");
      expect(decision.userHint).toBeTruthy();
    }
    expect(verifyByRefutation).toHaveBeenCalledTimes(1);
  });

  it("allows when the action holds up under scrutiny", async () => {
    mockVerdict("holds");
    const decision = await makeEgressRefutationPack().evaluate(EMAIL_CALL, CRON);
    expect(decision.allowed).toBe(true);
  });

  it("fails open when the verdict is inconclusive (e.g. classifiers unavailable)", async () => {
    mockVerdict("inconclusive");
    const decision = await makeEgressRefutationPack().evaluate(EMAIL_CALL, CRON);
    expect(decision.allowed).toBe(true);
  });

  it("passes the disable env var and refutation lenses to the helper", async () => {
    mockVerdict("holds");
    await makeEgressRefutationPack().evaluate(EMAIL_CALL, CRON);
    const arg = verifyByRefutation.mock.calls[0][0];
    expect(arg.category).toBe("egress-refute");
    expect(arg.envDisableVar).toBe("LAX_EGRESS_REFUTE");
    expect(arg.lenses).toHaveLength(3);
    expect(arg.userPrompt).toContain("email_send");
  });
});
