import { describe, it, expect } from "vitest";
import {
  detectSingleActionStop,
  detectIncompleteMultiStep,
  detectPlanningOnly,
  detectUncommittedTurn,
  detectEvidenceStale,
} from "./detectors.js";
import { isCommittingTool } from "../committing-tool-check.js";
import type { TurnState } from "./state.js";

function turn(over: Partial<TurnState>): TurnState {
  return {
    assistantText: "",
    toolCallsThisIteration: [],
    toolsCalledThisTurn: new Set(),
    hasReasoning: false,
    completionTokens: 0,
    iteration: 1,
    evidenceCount: 0,
    evidenceHistory: [],
    // Both commit verdicts are REQUIRED on TurnState (state.ts) and default to
    // "nothing on record" — the value that lets a detector fire. A fixture that
    // means "this op committed something" must say so explicitly; `undefined`
    // and `false` are both falsy, so an omission would read as the firing case
    // rather than failing loudly.
    committedSubstantiveWork: false,
    committedWorkOrLedger: false,
    ...over,
  };
}

function bashTurn(command: string): TurnState {
  return turn({
    assistantText: "Ran step 1. Next, I'll do step 2.",
    toolCallsThisIteration: [{ name: "bash", arguments: JSON.stringify({ command }) }],
  });
}

describe("detectSingleActionStop — fires only on the ending iteration", () => {
  // The bug (HE-6): requiring exactly one PENDING exploratory call meant the
  // detector only ever fired mid-flight — the loop was still running and the
  // model was about to follow through on its own. A research worker doing one
  // web_search per iteration with normal "then/next" narration got
  // "Do not re-explore. Act." injected into a healthy turn.
  it("does not fire while an exploratory call is still pending", () => {
    const state = turn({
      assistantText: "Searching for the schedule. Then I'll compile the answer.",
      toolCallsThisIteration: [{ name: "web_search", arguments: JSON.stringify({ query: "schedule" }) }],
      toolsCalledThisTurn: new Set(["web_search"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  it.each([
    "cat src/index.ts",
    "sleep 70 && date",
    "npm run build",
  ])("does not fire for a pending bash call %j — mid-flight is never a stall", (cmd) => {
    expect(detectSingleActionStop(bashTurn(cmd))).toBeNull();
  });

  it("fires when the turn ends after one exploratory tool with an unmet promise", () => {
    const state = turn({
      assistantText: "Read the file. Next, I'll edit it.",
      toolsCalledThisTurn: new Set(["read"]),
    });
    expect(detectSingleActionStop(state)?.kind).toBe("single-action-stop");
  });

  it("fires on a continuation cue that introduces the model's OWN next action", () => {
    const state = turn({
      assistantText: "Found the config. Next, I'll update the port.",
      toolsCalledThisTurn: new Set(["grep"]),
    });
    expect(detectSingleActionStop(state)?.kind).toBe("single-action-stop");
  });

  // HE-6 (class fix): a completed research/web_search deliverable ends with an
  // ADVISORY tail addressed to the USER ("Next steps: compare quarterly") that
  // names no first-person self-action. Those are delivered answers, not stalls,
  // and must not nag — regardless of which past-tense report verb opens the
  // reply (Researched/Compiled/Analyzed/…), which is why enumerating opener or
  // action vocabulary kept leaking. We require first-person self-deferral and,
  // per the module's documented "err toward leaving the nudge off", accept that
  // a bare imperative continuation ("Next: update the port") no longer fires.
  it.each([
    "Researched the top five vendors and their pricing tiers. Next steps: compare quarterly.",
    "Compiled the vendor findings. Next steps: track pricing quarterly.",
    "Gathered the competitor data. Next steps: verify pricing quarterly.",
    "Analyzed the market data across five providers. Next: monitor trends.",
  ])("does not nag a delivered research recap with an advisory tail: %j", (assistantText) => {
    const state = turn({ assistantText, toolsCalledThisTurn: new Set(["web_search"]) });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  it("still nags a genuine one-tool stall that defers a first-person action", () => {
    const state = turn({
      assistantText: "Searched for the API docs. Next, I'll implement the client.",
      toolsCalledThisTurn: new Set(["web_search"]),
    });
    expect(detectSingleActionStop(state)?.kind).toBe("single-action-stop");
  });

  it("does not fire on a mid-sentence continuation word in descriptive prose", () => {
    const state = turn({
      assistantText: "The launch happens next Tuesday at 9am, per the announcement.",
      toolsCalledThisTurn: new Set(["web_search"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  it("does not fire for an ended bash-only turn — command no longer inspectable", () => {
    const state = turn({
      assistantText: "Listed the files. Next, I'll pick one.",
      toolsCalledThisTurn: new Set(["bash"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });

  it("does not fire when the turn used more than one distinct tool", () => {
    const state = turn({
      assistantText: "Read the file and searched the repo. Then I verified.",
      toolsCalledThisTurn: new Set(["read", "grep"]),
    });
    expect(detectSingleActionStop(state)).toBeNull();
  });
});

describe("detectIncompleteMultiStep", () => {
  // The observed failure: Grok/Codex run step 1 of a 3-step task, summarize,
  // and yield. The harness must drive them onward without forbidding summaries.
  it("fires when the model finished step 1 of 3 and yielded", () => {
    const state = turn({
      assistantText: "Step 1 complete: I ran `sleep 70 && date`. Returned Wed Jun 3 20:03:13.",
      enumeratedSteps: 3,
    });
    expect(detectIncompleteMultiStep(state)?.kind).toBe("incomplete-multistep");
  });

  it("does not fire once the final step is reached", () => {
    const state = turn({
      assistantText: "Step 3 complete. Final report: all three runs succeeded.",
      enumeratedSteps: 3,
    });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("does not fire for a single-step request", () => {
    const state = turn({ assistantText: "Step 1 complete.", enumeratedSteps: 0 });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("does not fire while the model is still calling tools", () => {
    const state = turn({
      assistantText: "Step 1 done, running step 2 now.",
      enumeratedSteps: 3,
      toolCallsThisIteration: [{ name: "bash", arguments: JSON.stringify({ command: "sleep 70 && date" }) }],
    });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("does not fire when the reply names no step", () => {
    const state = turn({ assistantText: "I ran the command and it worked.", enumeratedSteps: 3 });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });

  it("stands down when the model is waiting on the user", () => {
    const state = turn({
      assistantText: "Step 1 complete. Which step would you like me to do next?",
      enumeratedSteps: 3,
    });
    expect(detectIncompleteMultiStep(state)).toBeNull();
  });
});

// C7: the three detectors that used to re-derive "did this turn commit
// anything?" by scanning toolsCalledThisTurn with isCommittingTool now read
// verdicts the host already computed. They do NOT read the same one, and the
// fixtures below are built so that reading the wrong one flips an assertion:
//   - detectPlanningOnly asks "was it the USER'S work?" → SUBSTANTIVE
//     (arg-aware, model's own task_* ledger excluded).
//   - detectUncommittedTurn / detectEvidenceStale ask "is ANY committed side
//     effect on record?" → the UNION of RAW and SUBSTANTIVE, which is what the
//     producer puts in `committedWorkOrLedger` (post-turn-detector.ts). Handing
//     those two the substantive verdict alone makes them nag every read-only
//     research op to commit a change nobody asked for; handing them the raw
//     verdict alone makes them nag every op whose work was a pdf/browser/
//     http_request commit, because the name-only layer cannot see those three.
//     See detectors.ts.
// Every fixture sets BOTH verdicts, so no assertion here rests on an omitted
// field reading as false.
describe("commit signal — detectors read the plumbed commit verdicts (C7)", () => {
  // Pins the premise the fixture families rest on. If the registry ever
  // reclassifies these, the fixtures below stop meaning what they claim.
  it("premise: the name-only check calls `task_create` committing and the arg-aware tools not", () => {
    expect(isCommittingTool("task_create")).toBe(true);
    // The three ARG_AWARE_TOOLS, and the whole reason the union exists: if any
    // of these ever became name-only committing, the union's second half would
    // stop being the thing that spares them.
    expect(isCommittingTool("pdf")).toBe(false);
    expect(isCommittingTool("browser")).toBe(false);
    expect(isCommittingTool("http_request")).toBe(false);
  });

  const RECAP_THEN_PROMISE = "Created the report. I'll send it to the client next.";
  const NEUTRAL = "Looked through the vendor docs and the current draft.";

  // The op shape the split exists to protect: the user asked for findings, not
  // a change. Its only committing-BY-NAME call is the task list open-steps
  // seeds on turn 0 — so RAW is true, SUBSTANTIVE is false by definition.
  const READ_ONLY_RESEARCH = {
    toolsCalledThisTurn: new Set(["task_create", "web_search", "read", "grep"]),
    committedWorkOrLedger: true,
    committedSubstantiveWork: false,
  };
  // Only the model's own ledger moved — no research, no work.
  const LEDGER_ONLY = {
    toolsCalledThisTurn: new Set(["read", "task_create"]),
    committedWorkOrLedger: true,
    committedSubstantiveWork: false,
  };
  // Real work the name-only layer cannot see: `pdf`/`browser`/`http_request`
  // are arg-aware, so isCommittingTool answers false for them and the RAW half
  // of the union stays empty. `committedWorkOrLedger` is nonetheless TRUE here
  // because the producer passes RAW ∪ SUBSTANTIVE — that union is the only
  // reason these ops are not nagged to commit work they already committed.
  const PDF_CREATE_ONLY = {
    toolsCalledThisTurn: new Set(["read", "pdf"]),
    committedWorkOrLedger: true,
    committedSubstantiveWork: true,
  };
  const BROWSER_SUBMIT_ONLY = {
    toolsCalledThisTurn: new Set(["read", "browser"]),
    committedWorkOrLedger: true,
    committedSubstantiveWork: true,
  };
  const HTTP_POST_ONLY = {
    toolsCalledThisTurn: new Set(["read", "http_request"]),
    committedWorkOrLedger: true,
    committedSubstantiveWork: true,
  };
  // Pure exploration, no plan written down: nothing on record either way.
  const NOTHING_COMMITTED = {
    toolsCalledThisTurn: new Set(["read", "grep"]),
    committedWorkOrLedger: false,
    committedSubstantiveWork: false,
  };

  describe("detectPlanningOnly — reads SUBSTANTIVE", () => {
    it("still fires on an op whose only commit was the model's own task ledger", () => {
      // RAW is true here, so this also proves the site is not reading RAW.
      const state = turn({ ...LEDGER_ONLY, assistantText: RECAP_THEN_PROMISE });
      expect(detectPlanningOnly(state)?.kind).toBe("planning-only");
    });

    it("stands down on a recap of an op whose only work was a `pdf create`", () => {
      // The LEDGER_ONLY case above is what proves this site reads SUBSTANTIVE
      // and not `committedWorkOrLedger`; this one cannot, because the union
      // makes both verdicts true for a pdf-create op. It pins the outcome that
      // matters instead: a recap of real arg-aware work is not a stalled plan.
      const state = turn({ ...PDF_CREATE_ONLY, assistantText: RECAP_THEN_PROMISE });
      expect(detectPlanningOnly(state)).toBeNull();
    });
  });

  describe("detectUncommittedTurn — reads the RAW ∪ SUBSTANTIVE union", () => {
    it("does NOT fire on a read-only research op (task ledger + web_search/read/grep)", () => {
      // The regression the substantive verdict caused: this op is doing exactly
      // what was asked and can never satisfy "call the tool that actually
      // commits work", so the nudge would repeat until the budget ran out.
      const state = turn({ ...READ_ONLY_RESEARCH, assistantText: NEUTRAL });
      expect(detectUncommittedTurn(state)).toBeNull();
    });

    it("fires when the op committed nothing at all", () => {
      const state = turn({ ...NOTHING_COMMITTED, assistantText: NEUTRAL });
      expect(detectUncommittedTurn(state)?.kind).toBe("uncommitted-turn");
    });

    // The RAW half is empty for all three arg-aware tools, so before the
    // producer switched to the union these ops were told to "call the tool that
    // actually commits work" right after committing it.
    for (const [label, fixture] of [
      ["a `browser` submit", BROWSER_SUBMIT_ONLY],
      ["a `pdf create`", PDF_CREATE_ONLY],
      ["an `http_request` POST", HTTP_POST_ONLY],
    ] as const) {
      it(`does NOT fire when the op's only work was ${label}`, () => {
        const state = turn({ ...fixture, assistantText: NEUTRAL });
        expect(detectUncommittedTurn(state)).toBeNull();
      });
    }
  });

  describe("detectEvidenceStale — reads the RAW ∪ SUBSTANTIVE union", () => {
    const FLAT = [4, 4, 4];

    it("does NOT fire on a read-only research op with a flat evidence window", () => {
      const state = turn({ ...READ_ONLY_RESEARCH, assistantText: NEUTRAL, evidenceHistory: FLAT });
      expect(detectEvidenceStale(state)).toBeNull();
    });

    it("fires when the flat window committed nothing at all", () => {
      const state = turn({ ...NOTHING_COMMITTED, assistantText: NEUTRAL, evidenceHistory: FLAT });
      expect(detectEvidenceStale(state)?.kind).toBe("evidence-stale");
    });

    // Same three ops, same reason as the sibling loop above.
    for (const [label, fixture] of [
      ["a `pdf create`", PDF_CREATE_ONLY],
      ["a `browser` submit", BROWSER_SUBMIT_ONLY],
      ["an `http_request` POST", HTTP_POST_ONLY],
    ] as const) {
      it(`does NOT fire when the op's only work was ${label}`, () => {
        const state = turn({ ...fixture, assistantText: NEUTRAL, evidenceHistory: FLAT });
        expect(detectEvidenceStale(state)).toBeNull();
      });
    }
  });
});
