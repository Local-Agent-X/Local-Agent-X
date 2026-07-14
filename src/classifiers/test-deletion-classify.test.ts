import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared classifier chokepoint BEFORE importing test-deletion-classify.
// classifySchema routes through it with an identity parse; the mock resolves
// RAW model text so the real JSON.parse → zod pipeline is exercised. We assert
// the judge shapes the call (category, env var, the load-bearing facts in the
// prompt) and maps the validated verdict.
const classifyWithLLMMock = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>): Promise<string | null> => null),
);
vi.mock("./classify-with-llm.js", () => ({
  classifyWithLLM: (...args: unknown[]) => classifyWithLLMMock(...(args as [Record<string, unknown>])),
}));

const { classifyTestDeletion } = await import("./test-deletion-classify.js");

type Llm = (system: string, user: string) => Promise<string | null>;
const llmReturning = (...replies: (string | null)[]) => {
  const fn = vi.fn<Llm>();
  for (const r of replies) fn.mockResolvedValueOnce(r);
  return fn;
};

const baseArgs = {
  userRequest: "fix the failing suite",
  deletedTests: ["src/foo.test.ts"],
  editedPaths: ["src/foo.ts"],
  subjects: [{ test: "src/foo.test.ts", subjectGuess: "src/foo.ts", subjectExists: true }],
};

describe("classifyTestDeletion — schema-validated LLM judge", () => {
  beforeEach(() => classifyWithLLMMock.mockReset());

  it("maps a DODGE verdict", async () => {
    const llm = llmReturning('{"verdict":"DODGE","reason":"subject still live"}');
    expect(await classifyTestDeletion({ ...baseArgs, _llm: llm })).toBe("dodge");
  });

  it("maps a LEGIT verdict onto 'legit-cleanup'", async () => {
    const llm = llmReturning('{"verdict":"LEGIT","reason":"feature was removed"}');
    expect(await classifyTestDeletion({ ...baseArgs, _llm: llm })).toBe("legit-cleanup");
  });

  it("returns null when the LLM is unavailable — no retry (caller fails safe)", async () => {
    const llm = llmReturning(null);
    expect(await classifyTestDeletion({ ...baseArgs, _llm: llm })).toBe(null);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("rejects an off-vocabulary verdict after the single retry", async () => {
    const llm = llmReturning('{"verdict":"maybe?"}', "DODGE — but not as JSON");
    expect(await classifyTestDeletion({ ...baseArgs, _llm: llm })).toBe(null);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("calls the chokepoint with category 'test-deletion' + the disable env var", async () => {
    classifyWithLLMMock.mockResolvedValue('{"verdict":"DODGE","reason":"r"}');
    expect(await classifyTestDeletion(baseArgs)).toBe("dodge");
    const arg = classifyWithLLMMock.mock.calls[0][0];
    expect(arg.category).toBe("test-deletion");
    expect(arg.envDisableVar).toBe("LAX_LLM_TEST_DELETION_JUDGE");
  });

  it("puts the load-bearing facts in the prompt: user request, deleted test, subject-live signal", async () => {
    const llm = llmReturning('{"verdict":"DODGE","reason":"r"}');
    await classifyTestDeletion({ ...baseArgs, _llm: llm });
    const user = llm.mock.calls[0][1];
    expect(user).toContain("fix the failing suite");
    expect(user).toContain("src/foo.test.ts");
    expect(user).toMatch(/still live/i);
  });

  it("prompt marks a gone subject as dead when the code was removed", async () => {
    const llm = llmReturning('{"verdict":"LEGIT","reason":"r"}');
    await classifyTestDeletion({
      ...baseArgs,
      subjects: [{ test: "src/foo.test.ts", subjectGuess: "src/foo.ts", subjectExists: false }],
      _llm: llm,
    });
    expect(llm.mock.calls[0][1]).toMatch(/subject is gone/i);
  });

  it("system prompt encodes the decision order: user-asked → legit, subject-gone → legit, else → dodge", async () => {
    const llm = llmReturning('{"verdict":"DODGE","reason":"r"}');
    await classifyTestDeletion({ ...baseArgs, _llm: llm });
    const system = llm.mock.calls[0][0];
    expect(system).toMatch(/explicitly ask to delete\/remove/i);
    expect(system).toMatch(/subject file no longer exists/i);
    expect(system).toMatch(/reply DODGE/i);
  });
});
