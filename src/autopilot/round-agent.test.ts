/**
 * Autopilot round-op provenance.
 *
 * The round agent's "user message" is the kick `Begin round N.` — composed
 * here, never typed by anyone. The mission the user actually wrote lives in the
 * system prompt, which the instruction ledger does not read.
 *
 * Stated honestly: unlike the self_edit surgeon and the agent-to-agent wakes,
 * this text extracts NOTHING today — the phrase gate finds no cue in it, so the
 * unstamped op already got an empty ledger. The stamp is a contract fix, not a
 * live-brick fix: it makes the op's provenance match reality, so a later edit to
 * the kick (or a nudge fragment moved into it) cannot silently start feeding
 * harness prose to the constraint extractor. The first assertion below pins the
 * kick's exact shape for that reason — if it grows into real prose, this test is
 * the place that notices.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AutopilotConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(async () => ({
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    stopReason: "end_turn",
  })),
}));

vi.mock("../canonical-loop/index.js", () => ({ runAgentViaCanonical: mocks.runAgent }));
vi.mock("../security/index.js", () => ({
  SecurityLayer: class { addAllowedPath(): void {} removeAllowedPath(): void {} },
}));
vi.mock("../security/layer/index.js", () => ({ loadFileAccessModeAtLeast: () => "common" }));

const autopilot: AutopilotConfig = {
  topic: "tighten the scheduler",
  scope: [],
  durationMs: 30 * 60 * 1000,
  maxRounds: 20,
  maxNoopRounds: 2,
  maxSelfEditCalls: 5,
  withTests: false,
  worktreePath: "/tmp/lax-autopilot-worktree",
  worktreeName: "autopilot-test",
  branchName: "autopilot/test/1",
  baseBranch: "main",
  buildCommand: null,
  buildTimeoutMs: 60_000,
  testCommand: "npm test",
  testTimeoutMs: 60_000,
  fileSizeLimit: 400,
};

beforeEach(() => {
  mocks.runAgent.mockClear();
});

describe("autopilot round op provenance", () => {
  it("marks the round kick harness-authored", async () => {
    const { runAutopilotRound } = await import("./round-agent.js");

    await runAutopilotRound(
      {
        config: { maxIterations: 10, temperature: 0.3 } as never,
        apiKey: "key",
        model: "claude-opus-4-6",
        provider: "anthropic",
        allTools: [],
      },
      {
        opId: "op-autopilot-provenance",
        autopilot,
        round: 3,
        timeRemainingMs: 10 * 60 * 1000,
        roundsCompleted: 2,
        selfEditUsed: 0,
      },
    );

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const calls = mocks.runAgent.mock.calls as unknown as Array<[
      string,
      unknown[],
      { opType: string; harnessAuthoredTask?: boolean },
    ]>;
    const [userMessage, , options] = calls[0];
    // The whole task text, verbatim — no user speech in it.
    expect(userMessage).toBe("Begin round 3.");
    expect(options.opType).toBe("autopilot_round");
    expect(options.harnessAuthoredTask).toBe(true);
  });
});
