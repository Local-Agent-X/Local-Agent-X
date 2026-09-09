/**
 * The dream/consolidation agent must persist memory ONLY through the canonical
 * gated tools (Facts DB + profiles). Handing it raw write/edit let it improvise
 * dup .md files + a dead-link MEMORY.md index — the exact drift this fix kills.
 * If a future change reintroduces a raw file-write tool to the dream agent, this
 * test fails before it can ship.
 */
import { describe, it, expect, vi } from "vitest";
import { DREAM_TOOL_NAMES } from "./prompts.js";

type DreamRunner = (opts: { force?: boolean }) => Promise<{ ran: boolean }>;

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(async () => ({
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    stopReason: "end_turn",
  })),
  runner: undefined as ((opts: { force?: boolean }) => Promise<{ ran: boolean }>) | undefined,
  transcripts: [] as Array<{ id: string; text: string }>,
}));

vi.mock("../../canonical-loop/index.js", () => ({ runAgentViaCanonical: mocks.runAgent }));
vi.mock("../../security/index.js", () => ({ SecurityLayer: class {} }));
vi.mock("../../agent-request/index.js", () => ({
  resolveProvider: async () => ({ provider: "anthropic", apiKey: "key", model: "claude-opus-4-6" }),
}));
vi.mock("../../memory/universal-index.js", () => ({ getUniversalIndex: () => null }));
vi.mock("../../memory/dream.js", () => ({
  registerDreamRunner: (runner: DreamRunner) => { mocks.runner = runner; },
  shouldDream: () => true,
  startDream: () => {},
  completeDream: () => {},
  failDream: () => {},
  buildDreamPrompt: () => "# Dream: Memory Consolidation\n\nReview the recent sessions.",
  buildDreamPromptForBatch: (_batch: unknown, i: number, total: number) =>
    `# Dream: Memory Consolidation (batch ${i + 1}/${total})`,
  listRecentSessionTranscripts: () => mocks.transcripts,
  buildDreamBatches: (transcripts: Array<{ id: string }>) => transcripts.map((t) => [t]),
}));

describe("dream agent toolset — canonical memory only", () => {
  it("includes the gated memory-mutation + lookup tools", () => {
    for (const t of [
      "remember",
      "update_fact",
      "forget",
      "memory_set_user_field",
      "memory_update_profile",
      "memory_search",
      "read",
    ]) {
      expect(DREAM_TOOL_NAMES).toContain(t);
    }
  });

  it("excludes raw file-write tools that let it improvise free-form memory files", () => {
    for (const t of ["write", "edit", "glob", "grep", "memory_save"]) {
      expect(DREAM_TOOL_NAMES as readonly string[]).not.toContain(t);
    }
  });
});

/**
 * The dream brief is machine-composed prose ("# Dream: Memory Consolidation
 * ... Review the transcripts"), never something the user typed. It must reach
 * canonical marked harness-authored, so the instruction-ledger middleware
 * skips constraint extraction on it (src/canonical-loop/middlewares/
 * instruction-ledger.ts) instead of mining the brief's directives into a
 * ledger of "user" prohibitions that then gate the run's own tools.
 *
 * Scope: this pins the flag at the runner boundary — the same seam
 * chunk-runner.test.ts and skill-review-fork.test.ts assert on. Mapping
 * `harnessAuthoredTask` → `op.taskProvenance = "harness"` is run.ts's single
 * shared expression (agent-runner/run.ts), not something this test reaches
 * past the mock.
 */
describe("dream op provenance", () => {
  it("marks both the single-pass and per-batch dream runs harness-authored", async () => {
    const { registerDreamRunnerForServer } = await import("./dream-check.js");

    // No transcripts → the single-pass branch; one transcript → the batch loop.
    for (const transcripts of [[], [{ id: "s1", text: "user: hi" }]]) {
      mocks.runAgent.mockClear();
      mocks.transcripts = transcripts;

      registerDreamRunnerForServer({
        config: {} as never,
        dataDir: ".",
        sessionStore: { list: () => [] } as never,
        secretsStore: {} as never,
        security: {} as never,
        toolPolicy: {} as never,
        allAgentTools: [],
        saveSession: async () => {},
      });

      await expect(mocks.runner!({ force: true })).resolves.toMatchObject({ ran: true });

      expect(mocks.runAgent).toHaveBeenCalledTimes(1);
      const calls = mocks.runAgent.mock.calls as unknown as Array<[
        string,
        unknown[],
        { opType: string; harnessAuthoredTask?: boolean },
      ]>;
      const [userMessage, , options] = calls[0];
      expect(options.opType).toBe("memory_consolidation");
      expect(options.harnessAuthoredTask).toBe(true);
      // The task really is harness prose, which is why the flag matters.
      expect(userMessage).toContain("Dream: Memory Consolidation");
    }
  });
});
