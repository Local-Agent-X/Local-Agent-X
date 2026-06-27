import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared classifier infra BEFORE importing give-up-classify so the
// binding is in place when the module resolves its `classifyYesNo` import.
// classifyGaveUp is a thin pass-through; we assert it forwards the verdict and
// shapes the call (category + task/finalText in the userPrompt) correctly.
const classifyYesNoMock = vi.fn<typeof import("./classify-with-llm.js").classifyYesNo>();
vi.mock("./classify-with-llm.js", () => ({
  classifyYesNo: (...args: Parameters<typeof import("./classify-with-llm.js").classifyYesNo>) =>
    classifyYesNoMock(...args),
}));

const { classifyGaveUp } = await import("./give-up-classify.js");

describe("classifyGaveUp — pass-through over classifyYesNo", () => {
  beforeEach(() => {
    classifyYesNoMock.mockReset();
  });

  it("returns true when the LLM says the assistant gave up", async () => {
    classifyYesNoMock.mockResolvedValue(true);
    expect(await classifyGaveUp({ task: "open the page", finalText: "you'll need to dismiss the banner" })).toBe(true);
  });

  it("returns false when the LLM says it completed / hit a user-only blocker", async () => {
    classifyYesNoMock.mockResolvedValue(false);
    expect(await classifyGaveUp({ task: "log me in", finalText: "I need your 2FA code" })).toBe(false);
  });

  it("returns null when the LLM is unavailable (caller falls back to regex)", async () => {
    classifyYesNoMock.mockResolvedValue(null);
    expect(await classifyGaveUp({ task: "x", finalText: "y" })).toBe(null);
  });

  it("calls classifyYesNo with category 'give-up' and the task + final text in the userPrompt", async () => {
    classifyYesNoMock.mockResolvedValue(true);
    await classifyGaveUp({ task: "TASK_MARKER", finalText: "FINAL_MARKER" });

    expect(classifyYesNoMock).toHaveBeenCalledTimes(1);
    const arg = classifyYesNoMock.mock.calls[0][0];
    expect(arg.category).toBe("give-up");
    expect(arg.envDisableVar).toBe("LAX_LLM_GIVE_UP_VERIFY");
    expect(arg.userPrompt).toContain("TASK_MARKER");
    expect(arg.userPrompt).toContain("FINAL_MARKER");
  });

  it("the prompt treats a delivered answer as complete even when hedged (anti-doubling guard)", async () => {
    classifyYesNoMock.mockResolvedValue(false);
    await classifyGaveUp({ task: "headline", finalText: "answered" });
    const arg = classifyYesNoMock.mock.calls[0][0];
    expect(arg.systemPrompt).toMatch(/answer.*(present|delivered)/i);
  });
});
