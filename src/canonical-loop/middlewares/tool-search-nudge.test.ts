import { describe, it, expect, afterEach } from "vitest";
import {
  toolSearchNudgeMiddleware,
  createToolSearchNudgeMiddleware,
  looksLikeCapabilityDenial,
  llmConfirm,
  type ConfirmDenialFn,
} from "./tool-search-nudge.js";
import { vi } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { setOpLedger } from "../instruction-ledger/index.js";
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";
import type { CapabilityClass } from "../../tool-registry.js";

let _op = 0;
function opId(): string { return `op-tsn-test-${++_op}`; }

function ctxFor(
  op: string,
  opts: { content: string; toolCalls?: number; searchedThisOp?: boolean },
): CanonicalLoopContext {
  return {
    op: { id: op },
    assistantContent: opts.content,
    toolCalls: new Array(opts.toolCalls ?? 0).fill({ name: "x" }),
    toolsCalledThisOp: new Set(opts.searchedThisOp ? ["tool_search"] : []),
  } as unknown as CanonicalLoopContext;
}

// Default instance uses the real llmConfirm; in the test env there is no
// provider, so classifyWithLLM returns null and the middleware falls back to
// the deterministic regex fire (fail-open). That is exactly the null-confirm
// regression path, so the pre-existing middleware suite exercises it unchanged.
const run = (op: string, opts: Parameters<typeof ctxFor>[1]) =>
  toolSearchNudgeMiddleware.afterModelCall!(ctxFor(op, opts));

// Pin the confirm verdict for the LLM-gated paths.
const runWith = (
  confirm: ConfirmDenialFn,
  op: string,
  opts: Parameters<typeof ctxFor>[1],
) => createToolSearchNudgeMiddleware(confirm).afterModelCall!(ctxFor(op, opts));

const CONFIRM_GAP: ConfirmDenialFn = async () => "gap";
const CONFIRM_ETHICAL: ConfirmDenialFn = async () => "ethical";
const CONFIRM_NORMAL: ConfirmDenialFn = async () => "not-a-refusal";
const CONFIRM_NULL: ConfirmDenialFn = async () => null;

describe("looksLikeCapabilityDenial", () => {
  it("fires on capability denials", () => {
    for (const t of [
      "I do not have a computer control tool or mouse movement capability.",
      "Sorry, I can't move the mouse.",
      "I don't have the ability to control your computer.",
      "There's no tool for that.",
      "That's beyond my capabilities.",
      "I'm not able to click on things for you.",
      "No tool for mouse control.",
      "Can't click that — no mouse control.",
    ]) {
      expect(looksLikeCapabilityDenial(t), t).toBe(true);
    }
  });

  it("does NOT fire on ethical refusals", () => {
    for (const t of [
      "I won't help with that request.",
      "I'm not comfortable assisting with that.",
      "I can't help with that request — it could cause harm.",
    ]) {
      expect(looksLikeCapabilityDenial(t), t).toBe(false);
    }
  });

  it("does NOT fire on normal answers", () => {
    for (const t of [
      "The capital of France is Paris.",
      "Here's the summary you asked for: the build passed and tests are green.",
      "Done — I moved the file and updated the imports.",
      "No, Paris is the capital of France.",
      "",
    ]) {
      expect(looksLikeCapabilityDenial(t), t).toBe(false);
    }
  });
});

describe("tool-search-nudge middleware", () => {
  it("nudges on a capability denial with zero tool calls", async () => {
    const r = await run(opId(), { content: "I don't have a tool to move the mouse." });
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("tool-search-recovery");
    expect((r as { message: string }).message).toContain("tool_search");
  });

  it("does NOT nudge when the turn made tool calls", async () => {
    const r = await run(opId(), { content: "I can't move the mouse.", toolCalls: 1 });
    expect(r.kind).toBe("continue");
  });

  it("does NOT nudge when tool_search already ran this op", async () => {
    const r = await run(opId(), { content: "I can't move the mouse.", searchedThisOp: true });
    expect(r.kind).toBe("continue");
  });

  it("does NOT nudge on a normal tool-less answer", async () => {
    const r = await run(opId(), { content: "The capital of France is Paris." });
    expect(r.kind).toBe("continue");
  });

  it("does NOT nudge on an ethical refusal", async () => {
    const r = await run(opId(), { content: "I won't help with that request." });
    expect(r.kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const op = opId();
    expect((await run(op, { content: "I can't do that — no tool for it." })).kind).toBe("nudge");
    expect((await run(op, { content: "Still can't, I have no such tool." })).kind).toBe("continue");
  });
});

describe("LLM confirm gate (three-way denial classifier)", () => {
  it("nudges when confirm returns a capability GAP", async () => {
    const r = await runWith(CONFIRM_GAP, opId(), {
      content: "I don't have a tool to move the mouse.",
    });
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("tool-search-recovery");
  });

  it("SUPPRESSES when confirm returns an ethical refusal, even if the ETHICAL regex carve-out was slipped", async () => {
    // A safety refusal dressed as "I can't <verb>" — the regex ETHICAL_REFUSAL
    // carve-out does NOT catch it (no "won't"/"not comfortable"/…), so it
    // passes looksLikeCapabilityDenial and would have been pushed to
    // tool_search under the old hardcoded list. The LLM sees the safety intent
    // and vetoes. This is the fragile-carve-out fix: the classifier, not the
    // hardcoded regex list, is what stops an ethical refusal from nudging.
    const content = "I can't create malware for you to attack that server.";
    expect(looksLikeCapabilityDenial(content)).toBe(true); // slips the regex carve-out
    const r = await runWith(CONFIRM_ETHICAL, opId(), { content });
    expect(r.kind).toBe("continue");
  });

  it("SUPPRESSES a regex false positive when confirm returns not-a-refusal", async () => {
    const r = await runWith(CONFIRM_NORMAL, opId(), {
      content: "I can't see any obvious errors — the run to launch the app looks clean.",
    });
    expect(r.kind).toBe("continue");
  });

  it("falls back to the regex fire when confirm is null (fail-open)", async () => {
    // Null verdict → deterministic floor: fires on a denial the regex accepts…
    const gap = await runWith(CONFIRM_NULL, opId(), {
      content: "I don't have a tool to move the mouse.",
    });
    expect(gap.kind).toBe("nudge");
    // …and still respects the regex ETHICAL carve-out (never reaches confirm).
    const ethical = await runWith(CONFIRM_NULL, opId(), {
      content: "I won't help with that request.",
    });
    expect(ethical.kind).toBe("continue");
  });

  it("fires at most once per op even under the confirm gate", async () => {
    const op = opId();
    expect((await runWith(CONFIRM_GAP, op, { content: "No tool for mouse control." })).kind).toBe("nudge");
    expect((await runWith(CONFIRM_GAP, op, { content: "Still no such tool." })).kind).toBe("continue");
  });
});

describe("llmConfirm — schema-validated denial verdict", () => {
  type Llm = (system: string, user: string) => Promise<string | null>;
  const llmReturning = (...replies: (string | null)[]) => {
    const fn = vi.fn<Llm>();
    for (const r of replies) fn.mockResolvedValueOnce(r);
    return fn;
  };

  it.each([
    ['{"verdict":"GAP","reason":"thinks it has no mouse tool"}', "gap"],
    ['{"verdict":"ETHICAL","reason":"declines on safety grounds"}', "ethical"],
    ['{"verdict":"NORMAL","reason":"just answers the question"}', "not-a-refusal"],
  ])("maps %s → %s", async (reply, expected) => {
    const llm = llmReturning(reply);
    expect(await llmConfirm("I can't move the mouse.", llm)).toBe(expected);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][1]).toContain("I can't move the mouse.");
  });

  it("an off-vocabulary verdict is retried once, then null (regex floor applies)", async () => {
    const llm = llmReturning('{"verdict":"KINDA"}', "GAP but not as JSON");
    expect(await llmConfirm("I can't move the mouse.", llm)).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("LLM unavailable → null without a retry", async () => {
    const llm = llmReturning(null);
    expect(await llmConfirm("I can't move the mouse.", llm)).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe("instruction-ledger gating (targeted suppression)", () => {
  afterEach(() => _resetOpLedgers());

  function forbid(op: string, ...prohibitions: CapabilityClass[]): void {
    setOpLedger(op, { prohibitions, obligations: [], phrases: ["no browsing"] });
  }

  it("suppresses the nudge when the denial is about a capability the user forbade", async () => {
    const op = opId();
    forbid(op, "egress");
    const r = await run(op, { content: "I can't browse the web to fetch that page." });
    expect(r.kind).toBe("continue");
  });

  it("still nudges when the denial is about a DIFFERENT capability than the forbidden one", async () => {
    const op = opId();
    forbid(op, "egress");
    const r = await run(op, { content: "Sorry, I can't move the mouse." });
    expect(r.kind).toBe("nudge");
  });

  it("still nudges with no ledger at all (fail-open)", async () => {
    const r = await run(opId(), { content: "I can't browse the web to fetch that page." });
    expect(r.kind).toBe("nudge");
  });
});
