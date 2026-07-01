import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared classifier infra BEFORE importing test-deletion-classify so the
// binding is in place when the module resolves its `classifyWithLLM` import. We
// assert the judge shapes the call (category, env var, the load-bearing facts in
// the prompt) and forwards the parsed verdict; the parse itself is exercised via
// the real `parse` callback the module passes to classifyWithLLM.
type ClassifyWithLLM = typeof import("./classify-with-llm.js").classifyWithLLM;
const classifyWithLLMMock = vi.fn<ClassifyWithLLM>();
vi.mock("./classify-with-llm.js", () => ({
  classifyWithLLM: (...args: Parameters<ClassifyWithLLM>) => classifyWithLLMMock(...args),
}));

const { classifyTestDeletion } = await import("./test-deletion-classify.js");

const baseArgs = {
  userRequest: "fix the failing suite",
  deletedTests: ["src/foo.test.ts"],
  editedPaths: ["src/foo.ts"],
  subjects: [{ test: "src/foo.test.ts", subjectGuess: "src/foo.ts", subjectExists: true }],
};

describe("classifyTestDeletion — LLM judge over classifyWithLLM", () => {
  beforeEach(() => classifyWithLLMMock.mockReset());

  it("forwards a 'dodge' verdict", async () => {
    classifyWithLLMMock.mockResolvedValue("dodge");
    expect(await classifyTestDeletion(baseArgs)).toBe("dodge");
  });

  it("forwards a 'legit-cleanup' verdict", async () => {
    classifyWithLLMMock.mockResolvedValue("legit-cleanup");
    expect(await classifyTestDeletion(baseArgs)).toBe("legit-cleanup");
  });

  it("returns null when the LLM is unavailable (caller fails safe)", async () => {
    classifyWithLLMMock.mockResolvedValue(null);
    expect(await classifyTestDeletion(baseArgs)).toBe(null);
  });

  it("calls with category 'test-deletion' + the disable env var", async () => {
    classifyWithLLMMock.mockResolvedValue("dodge");
    await classifyTestDeletion(baseArgs);
    const arg = classifyWithLLMMock.mock.calls[0][0];
    expect(arg.category).toBe("test-deletion");
    expect(arg.envDisableVar).toBe("LAX_LLM_TEST_DELETION_JUDGE");
  });

  it("puts the load-bearing facts in the prompt: user request, deleted test, subject-live signal", async () => {
    classifyWithLLMMock.mockResolvedValue("dodge");
    await classifyTestDeletion(baseArgs);
    const arg = classifyWithLLMMock.mock.calls[0][0];
    expect(arg.userPrompt).toContain("fix the failing suite");
    expect(arg.userPrompt).toContain("src/foo.test.ts");
    expect(arg.userPrompt).toMatch(/still live/i);
  });

  it("prompt marks a gone subject as dead when the code was removed", async () => {
    classifyWithLLMMock.mockResolvedValue("legit-cleanup");
    await classifyTestDeletion({
      ...baseArgs,
      subjects: [{ test: "src/foo.test.ts", subjectGuess: "src/foo.ts", subjectExists: false }],
    });
    const arg = classifyWithLLMMock.mock.calls[0][0];
    expect(arg.userPrompt).toMatch(/subject is gone/i);
  });

  it("system prompt encodes the decision order: user-asked → legit, subject-gone → legit, else → dodge", async () => {
    classifyWithLLMMock.mockResolvedValue("dodge");
    await classifyTestDeletion(baseArgs);
    const arg = classifyWithLLMMock.mock.calls[0][0];
    expect(arg.systemPrompt).toMatch(/explicitly ask to delete\/remove/i);
    expect(arg.systemPrompt).toMatch(/subject file no longer exists/i);
    expect(arg.systemPrompt).toMatch(/reply DODGE/i);
  });

  it("the parse maps DODGE/LEGIT (case-insensitive) and rejects garbage", async () => {
    // Grab the real parse the module handed to classifyWithLLM.
    classifyWithLLMMock.mockResolvedValue("dodge");
    await classifyTestDeletion(baseArgs);
    const parse = classifyWithLLMMock.mock.calls[0][0].parse!;
    expect(parse("DODGE — foo still exists")).toBe("dodge");
    expect(parse("legit: the feature was removed")).toBe("legit-cleanup");
    expect(parse("Legit")).toBe("legit-cleanup");
    expect(parse("maybe?")).toBe(null);
    expect(parse("")).toBe(null);
  });
});
