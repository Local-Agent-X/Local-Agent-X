/**
 * self_edit surgeon op provenance.
 *
 * This is the one site in this chunk with a measured live brick, not a contract
 * gap. The surgeon's task text is buildSelfEditPrompt's envelope
 * (src/self-edit/prompt.ts) plus whatever AGENTS.md rules collectSubtreeRules
 * pulls in, and that prose is dense with "Do NOT commit or push", "do NOT run
 * 'npm install'", "never hand-edit" — STRONG-tier phrase-gate matches for a
 * blanket workspace-write ban that survives an LLM outage. `self_edit` is not in
 * SYNTHETIC_CONTEXT_OP_TYPES, so before the provenance stamp the
 * instruction-ledger middleware recorded that ban and pre-dispatch enforced it,
 * hard-denying write/edit (workspace-write) and bash (shell) — the surgeon's
 * entire toolset, on a run whose whole job is editing LAX source. The surgeon
 * was denied by LAX's own rules file, quoted back at it. Same signature as the
 * 2026-07-22 Merchhelm preflight halt.
 *
 * WHAT THESE TESTS DO AND DO NOT COVER, stated plainly so nobody reads more
 * guarantee into them than they give:
 *
 *   - "the hazard" pins that the real prompt really does strong-extract a
 *     workspace-write ban, so the rest is not asserting a tautology.
 *   - "the runner" pins the one production line this chunk added.
 *   - "the middleware" pins the consequence GIVEN an op already stamped
 *     harness. It constructs that op itself; it does NOT exercise run.ts's
 *     `harnessAuthoredTask ? "harness" : undefined` mapping, and would stay
 *     green if that expression broke. That mapping is pinned directly, through
 *     the real runner, in
 *     canonical-loop/agent-runner/run.task-provenance.test.ts — the two tests
 *     together cover the path, neither one alone does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSelfEditPrompt } from "../../self-edit/prompt.js";
import {
  phraseGate,
  extractConstraints,
  createInstructionLedgerMiddleware,
  getOpLedger,
} from "../../canonical-loop/public/instruction-ledger.js";
// Test-only reset helpers — deliberately off the production surfaces.
import {
  _resetOpLedgers,
  _resetMiddlewareStates,
  makeCanonicalLoopContext,
} from "../../canonical-loop/public/test-surface.js";

type SurgeonRunner = (worktreePath: string, prompt: string, signal?: AbortSignal) => Promise<string>;

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(async () => ({
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    stopReason: "end_turn",
  })),
  surgeon: undefined as SurgeonRunner | undefined,
}));

vi.mock("../../canonical-loop/index.js", () => ({ runAgentViaCanonical: mocks.runAgent }));
vi.mock("../../security/index.js", () => ({
  SecurityLayer: class { addAllowedPath(): void {} removeAllowedPath(): void {} },
}));
vi.mock("../../security/layer/index.js", () => ({ loadFileAccessModeAtLeast: () => "common" }));
vi.mock("../../agent-request/index.js", () => ({
  resolveProvider: async () => ({ provider: "anthropic", apiKey: "key", model: "claude-opus-4-6" }),
}));
vi.mock("../../self-edit/generic-surgeon.js", () => ({
  registerGenericSurgeon: (runner: SurgeonRunner) => { mocks.surgeon = runner; },
}));

/** The real extractor with the LLM confirm stubbed to null — exercises the
 *  genuine phrase-gate + strong-tier path deterministically, zero network.
 *  Mirrors instruction-ledger.test.ts's offlineExtract. */
const offlineExtract = (msg: string) => extractConstraints(msg, async () => null);

const SURGEON_TASK = "fix the wedge in the scheduler";

/** Drive the registered runner once and hand back the canonical call it made. */
async function captureCanonicalCall(): Promise<{
  message: string;
  options: { opType: string; harnessAuthoredTask?: boolean };
}> {
  const { registerSelfEditSurgeonForServer } = await import("./self-edit-surgeon-runner.js");
  registerSelfEditSurgeonForServer({
    config: {} as never,
    dataDir: ".",
    secretsStore: {} as never,
    toolPolicy: {} as never,
    allAgentTools: [],
  });
  await vi.waitFor(() => expect(mocks.surgeon).toBeDefined());

  await mocks.surgeon!("/tmp/lax-selfedit-worktree", await buildSelfEditPrompt(SURGEON_TASK, ""));

  expect(mocks.runAgent).toHaveBeenCalledTimes(1);
  const calls = mocks.runAgent.mock.calls as unknown as Array<[
    string,
    unknown[],
    { opType: string; harnessAuthoredTask?: boolean },
  ]>;
  const [message, , options] = calls[0];
  return { message, options };
}

beforeEach(() => {
  _resetMiddlewareStates();
  _resetOpLedgers();
  mocks.runAgent.mockClear();
  mocks.surgeon = undefined;
});

describe("self_edit surgeon task provenance", () => {
  it("the hazard: the surgeon's own prompt strong-extracts a workspace-write ban", async () => {
    const gate = phraseGate(await buildSelfEditPrompt(SURGEON_TASK, ""));

    expect(gate.cues.length).toBeGreaterThan(0);
    // Deterministic tier — this stands even on a total LLM outage, which is why
    // an unstamped self_edit op was actually denied its own tools rather than
    // merely being at risk of it.
    expect(gate.strong.prohibitions).toContain("workspace-write");
  });

  it("the runner: marks the surgeon run harness-authored", async () => {
    const { options } = await captureCanonicalCall();

    expect(options.opType).toBe("self_edit");
    expect(options.harnessAuthoredTask).toBe(true);
  });

  it("the middleware: records nothing for a harness-stamped op carrying that prompt", async () => {
    const { message } = await captureCanonicalCall();

    // This op is stamped by the test, NOT by run.ts — see the module docstring.
    const mw = createInstructionLedgerMiddleware(offlineExtract);
    const c = makeCanonicalLoopContext({
      op: {
        id: "op-selfedit-provenance",
        type: "self_edit",
        lane: "background",
        taskProvenance: "harness",
      },
      turnIdx: 0,
      currentUserMessage: message,
    });

    const r = await mw.beforeTurn!(c);
    expect(r.kind).toBe("continue");
    // Empty ledger => pre-dispatch has nothing to deny write/edit/bash with.
    expect(getOpLedger(c.op.id)).toEqual({ prohibitions: [], obligations: [], phrases: [] });
  });
});
