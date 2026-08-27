import { describe, it, expect, beforeEach } from "vitest";
import {
  collectToolFailures,
  formatFailureNudgeForModel,
  shouldNudgeForFailures,
  resolveTerminatingMutation,
  MAX_BOOKKEEPING_DEFERRALS,
} from "../src/canonical-loop/turn-loop/tool-failure-summary.js";
import { isLedgerTool } from "../src/committing-tool-check.js";
import { _resetMiddlewareStates } from "../src/canonical-loop/middlewares/state.js";
import { MEMORY_WRITE_TOOLS } from "../src/canonical-loop/turn-loop/silent-tool-check.js";
import { isMutationTool } from "../src/tool-mutation-check.js";
import { TOOLS } from "../src/tool-registry.js";

function tm(text: string, toolCallId = "call-1") {
  return { role: "tool_result" as const, content: { text, toolCallId } };
}

describe("collectToolFailures", () => {
  it("returns no failures when every tool was ok", () => {
    const r = collectToolFailures(
      [tm("[ok] Wrote /x/y"), tm("[ok] Edited /x/y", "call-2")],
      [{ tool: "write" }, { tool: "edit", toolCallId: "call-2" }],
    );
    expect(r.failures).toEqual([]);
  });

  it("captures error / blocked / timeout statuses", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string found 2 times"),
        tm("[blocked, recovery=\"x\"] policy refused", "call-2"),
        tm("[timeout, duration_ms=60000] hung", "call-3"),
      ],
      [{ tool: "edit" }, { tool: "bash" }, { tool: "http_request" }],
    );
    expect(r.failures).toHaveLength(3);
    expect(r.failures[0].tool).toBe("edit");
    expect(r.failures[1].tool).toBe("bash");
    expect(r.failures[2].tool).toBe("http_request");
  });

  it("counts declined as a failure and tags it (user said no ≠ tool broken)", () => {
    const r = collectToolFailures(
      [tm("[declined]\nDECLINED by user: bash. Do not retry the same call — adjust your approach or ask the user.")],
      [{ tool: "bash" }],
    );
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].tool).toBe("bash");
    expect(r.failures[0].declined).toBe(true);
    expect(shouldNudgeForFailures(r)).toBe(true);
  });

  it("excludes running (async-started) results", () => {
    const r = collectToolFailures(
      [tm("[running, session_id=s1] started; poll process_status")],
      [{ tool: "process_start" }],
    );
    expect(r.failures).toEqual([]);
  });

  it("strips the status header from the reason line", () => {
    const r = collectToolFailures(
      [tm("[error]\nold_string found 2 times in level.js")],
      [{ tool: "edit" }],
    );
    expect(r.failures[0].reason).not.toMatch(/^\[error\]/);
    expect(r.failures[0].reason).toMatch(/old_string found 2 times/);
  });

  it("treats legacy ok results (no status header) as ok", () => {
    const r = collectToolFailures(
      [tm("Wrote /a/b.txt")],
      [{ tool: "write" }],
    );
    expect(r.failures).toEqual([]);
  });
});

describe("shouldNudgeForFailures — gaslighting heuristic", () => {
  it("nudges when failures present and no successful mutation", () => {
    const r = collectToolFailures(
      [tm("[error] old_string not found")],
      [{ tool: "edit" }],
    );
    expect(shouldNudgeForFailures(r)).toBe(true);
  });

  it("does NOT nudge when failures coexist with a successful write (pixel-platformer case)", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string not found", "call-1"),
        tm("[error] old_string not found", "call-2"),
        tm("[error] old_string not found", "call-3"),
        tm("[error] old_string not found", "call-4"),
        tm("[ok] Wrote /workspace/apps/pixel-platformer/js/game.js", "call-5"),
      ],
      [{ tool: "edit" }, { tool: "edit" }, { tool: "edit" }, { tool: "edit" }, { tool: "write" }],
    );
    expect(r.hadSuccessfulMutation).toBe(true);
    expect(shouldNudgeForFailures(r)).toBe(false);
  });

  it("does NOT nudge when failures coexist with a successful edit", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string found 2 times", "call-1"),
        tm("[ok] Edited /foo.js", "call-2"),
      ],
      [{ tool: "edit" }, { tool: "edit" }],
    );
    expect(shouldNudgeForFailures(r)).toBe(false);
  });

  it("STILL nudges when only read/grep/glob succeeded (model spamming reads after failed edits)", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string not found", "call-1"),
        tm("[ok] read file contents...", "call-2"),
        tm("[ok] grep results...", "call-3"),
      ],
      [{ tool: "edit" }, { tool: "read" }, { tool: "grep" }],
    );
    expect(r.hadSuccessfulMutation).toBe(false);
    expect(shouldNudgeForFailures(r)).toBe(true);
  });

  it("does NOT nudge when no failures (clean turn)", () => {
    const r = collectToolFailures(
      [tm("[ok] Wrote foo")],
      [{ tool: "write" }],
    );
    expect(shouldNudgeForFailures(r)).toBe(false);
  });
});

// The C9 split. ONE flag used to answer two questions: "was there a real change,
// so 'done' is iteration not gaslighting?" (A) and "can this TURN END here?" (B).
// The agent's own task ledger answers YES to A and NO to B — task_create is
// risk `workspace-write` so isMutationTool says mutation, but ending an op on
// the task_create that opened its steps is circular in the destructive
// direction. These cases pin the two fields apart at the source.
describe("collectToolFailures — question A (nudge) vs question B (termination)", () => {
  it("a task_create counts for the nudge question but NOT for termination", () => {
    const r = collectToolFailures(
      [tm("[ok] Created 3 tasks")],
      [{ tool: "task_create" }],
    );
    expect(r.hadSuccessfulMutation).toBe(true);   // A: a real change landed
    expect(r.hadTerminatingMutation).toBe(false); // B: planning is not a terminator
  });

  it("task_update is excluded from termination too (whole task_* ledger, not one name)", () => {
    const r = collectToolFailures(
      [tm("[ok] Marked step 2 complete")],
      [{ tool: "task_update" }],
    );
    expect(r.hadSuccessfulMutation).toBe(true);
    expect(r.hadTerminatingMutation).toBe(false);
  });

  it("CONTROL: a real file write answers YES to both — the split is not a blanket stand-down", () => {
    const r = collectToolFailures(
      [tm("[ok] Wrote /workspace/apps/x/index.html")],
      [{ tool: "write" }],
    );
    expect(r.hadSuccessfulMutation).toBe(true);
    expect(r.hadTerminatingMutation).toBe(true);
  });

  it("CONTROL: a read-only turn answers NO to both", () => {
    const r = collectToolFailures(
      [tm("[ok] file contents…")],
      [{ tool: "read" }],
    );
    expect(r.hadSuccessfulMutation).toBe(false);
    expect(r.hadTerminatingMutation).toBe(false);
  });

  it("a ledger write alongside a real write still terminates (the write carries B)", () => {
    const r = collectToolFailures(
      [tm("[ok] Created 3 tasks", "call-1"), tm("[ok] Wrote /x/y.ts", "call-2")],
      [{ tool: "task_create" }, { tool: "write", toolCallId: "call-2" }],
    );
    expect(r.hadSuccessfulMutation).toBe(true);
    expect(r.hadTerminatingMutation).toBe(true);
  });

  it("failures + a ledger write: nudge suppressed (A) while B stays false", () => {
    const r = collectToolFailures(
      [tm("[error] old_string not found", "call-1"), tm("[ok] Created 3 tasks", "call-2")],
      [{ tool: "edit" }, { tool: "task_create", toolCallId: "call-2" }],
    );
    expect(shouldNudgeForFailures(r)).toBe(false); // A: a change landed, not gaslighting
    expect(r.hadTerminatingMutation).toBe(false);  // B: op must keep going
  });
});

describe("formatFailureNudgeForModel", () => {
  it("returns empty when no failures", () => {
    expect(formatFailureNudgeForModel({ failures: [] })).toBe("");
  });

  it("tells the model not to claim done and lists the failed calls", () => {
    const msg = formatFailureNudgeForModel({
      failures: [
        { tool: "edit", reason: "old_string found 2 times in level.js" },
        { tool: "bash", reason: "PowerShell quoting error" },
      ],
    });
    expect(msg).toMatch(/2 tool calls/);
    expect(msg).toMatch(/Do NOT claim the task is done/);
    expect(msg).toMatch(/edit/);
    expect(msg).toMatch(/bash/);
    expect(msg).toMatch(/old_string found 2 times/);
    expect(msg).toMatch(/PowerShell quoting/);
  });

  it("gives declined failures distinct wording: adjust or ask, don't immediately repeat", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "bash", reason: "DECLINED by user: bash", declined: true }],
      hadSuccessfulMutation: false,
    });
    expect(msg).toMatch(/declined by the user/);
    expect(msg).toMatch(/Do not immediately repeat that call/);
    expect(msg).toMatch(/tool is NOT broken/);
    expect(msg).toMatch(/adjust your approach or ask the user/);
    // The designed re-raise flow stays open: "proceed" in chat → re-request.
    expect(msg).toMatch(/you may request approval again/);
  });

  it("an all-declined failure set gets a header that does NOT urge retrying", () => {
    const msg = formatFailureNudgeForModel({
      failures: [
        { tool: "bash", reason: "DECLINED by user: bash", declined: true },
        { tool: "delete_file", reason: "DECLINED by user: delete_file", declined: true },
      ],
      hadSuccessfulMutation: false,
    });
    expect(msg).toMatch(/declined by the user/);
    expect(msg).not.toMatch(/retried successfully/);
    expect(msg).not.toMatch(/recovery hints/);
    expect(msg).toMatch(/do NOT retry the declined calls as-is/);
  });

  it("a mixed declined+error set keeps the retry-oriented header (errors ARE retryable)", () => {
    const msg = formatFailureNudgeForModel({
      failures: [
        { tool: "edit", reason: "old_string not found" },
        { tool: "bash", reason: "DECLINED by user: bash", declined: true },
      ],
      hadSuccessfulMutation: false,
    });
    expect(msg).toMatch(/retried successfully/);
    expect(msg).toMatch(/declined by the user/);
  });

  it("does NOT add the declined note for ordinary errors", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "edit", reason: "old_string not found" }],
      hadSuccessfulMutation: false,
    });
    expect(msg).not.toMatch(/declined/i);
  });

  it("uses singular wording for one failure", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "edit", reason: "x" }],
    });
    expect(msg).toMatch(/1 tool call/);
    expect(msg).not.toMatch(/tool calls/);
  });

  it("is addressed to the model, not the user (no UI banner phrasing)", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "edit", reason: "x" }],
    });
    // Banner-style phrasing would say "the model's claims above" — that's
    // user-facing and has no place in a nudge addressed to the model.
    expect(msg).not.toMatch(/model's claims/);
    expect(msg).not.toMatch(/⚠/);
  });
});

// C9b — the C9 carve-out DEFERS termination, and deferring is only safe if
// something eventually stops the op. Nothing reliably does: worker.ts's per-op
// turn count is a checkpoint cadence that resets on `op.lane !== "interactive"`,
// its wall clock is armed for interactive only, and budget.maxTokens defaults to
// 0 = OFF with no production path stamping one. So the bound lives here.
describe("resolveTerminatingMutation — the bookkeeping deferral bound", () => {
  beforeEach(() => _resetMiddlewareStates());

  const ok = (text: string, toolCallId = "c1") =>
    ({ role: "tool_result" as const, content: { text: `[ok]\n${text}`, toolCallId } });

  /** A bookkeeping-only turn: a successful task_create and nothing else. */
  const planTurn = () => collectToolFailures([ok("created 3 tasks")], [{ tool: "task_create" }]);
  /** A real-work turn: a successful file write. */
  const writeTurn = () => collectToolFailures([ok("wrote /x/y.ts")], [{ tool: "write" }]);
  /** A read-only turn: successful, but no mutation of any kind. */
  const readTurn = () => collectToolFailures([ok("file contents…")], [{ tool: "read" }]);

  it(`defers exactly ${MAX_BOOKKEEPING_DEFERRALS} consecutive bookkeeping-only turns, then terminates`, () => {
    const answers: boolean[] = [];
    for (let i = 0; i < MAX_BOOKKEEPING_DEFERRALS + 1; i++) {
      answers.push(resolveTerminatingMutation("op-bound", planTurn()));
    }
    // The first N defer (false = do not terminate on the ledger write); the
    // N+1th spends the budget and returns the pre-C9 answer.
    expect(answers.slice(0, MAX_BOOKKEEPING_DEFERRALS)).toEqual(
      new Array(MAX_BOOKKEEPING_DEFERRALS).fill(false),
    );
    expect(answers[MAX_BOOKKEEPING_DEFERRALS]).toBe(true);
  });

  it("the budget is PER-OP — a spent op does not spend anyone else's", () => {
    for (let i = 0; i < MAX_BOOKKEEPING_DEFERRALS + 1; i++) resolveTerminatingMutation("op-a", planTurn());
    expect(resolveTerminatingMutation("op-a", planTurn())).toBe(true);
    // A different op starts with a full budget.
    expect(resolveTerminatingMutation("op-b", planTurn())).toBe(false);
  });

  it("real work RESETS the budget — and only real work can", () => {
    for (let i = 0; i < MAX_BOOKKEEPING_DEFERRALS; i++) {
      expect(resolveTerminatingMutation("op-reset", planTurn())).toBe(false);
    }
    // A real file write terminates AND refreshes the budget.
    expect(resolveTerminatingMutation("op-reset", writeTurn())).toBe(true);
    expect(resolveTerminatingMutation("op-reset", planTurn())).toBe(false);
  });

  it("read-only turns are NEUTRAL — interleaving them cannot launder the count", () => {
    // The hole a naive "reset on any non-bookkeeping turn" counter would leave:
    // plan / read / plan / read never terminates. Reads neither spend nor
    // refresh, so the 4th plan still terminates.
    expect(resolveTerminatingMutation("op-launder", planTurn())).toBe(false);
    expect(resolveTerminatingMutation("op-launder", readTurn())).toBe(false);
    expect(resolveTerminatingMutation("op-launder", planTurn())).toBe(false);
    expect(resolveTerminatingMutation("op-launder", readTurn())).toBe(false);
    expect(resolveTerminatingMutation("op-launder", planTurn())).toBe(false);
    expect(resolveTerminatingMutation("op-launder", readTurn())).toBe(false);
    expect(resolveTerminatingMutation("op-launder", planTurn())).toBe(true);
  });

  it("once spent it STAYS spent — a gate re-open does not buy another budget", () => {
    for (let i = 0; i < MAX_BOOKKEEPING_DEFERRALS + 1; i++) resolveTerminatingMutation("op-spent", planTurn());
    // Every subsequent bookkeeping-only turn terminates immediately.
    expect(resolveTerminatingMutation("op-spent", planTurn())).toBe(true);
    expect(resolveTerminatingMutation("op-spent", planTurn())).toBe(true);
  });

  it("VACUITY CONTROL: real work terminates on turn 1 and every turn after", () => {
    // Without this, a bound that simply returned false forever would pass every
    // "does not terminate" case above.
    for (let i = 0; i < 10; i++) {
      expect(resolveTerminatingMutation("op-vacuity-work", writeTurn())).toBe(true);
    }
  });

  it("VACUITY CONTROL: a read-only op NEVER terminates on this signal, however long", () => {
    // And without this, a bound that returned true after N turns regardless of
    // what happened would pass the bound test.
    for (let i = 0; i < 10; i++) {
      expect(resolveTerminatingMutation("op-vacuity-read", readTurn())).toBe(false);
    }
  });

  it("mixed bookkeeping + real work in ONE turn terminates and resets (the write carries B)", () => {
    const mixed = collectToolFailures(
      [ok("created 3 tasks", "c1"), ok("wrote /x/y.ts", "c2")],
      [{ tool: "task_create" }, { tool: "write", toolCallId: "c2" }],
    );
    expect(resolveTerminatingMutation("op-mixed", mixed)).toBe(true);
    expect(resolveTerminatingMutation("op-mixed", planTurn())).toBe(false);
  });
});

// C9b item 3 — memory writes are bookkeeping for the TERMINATION question.
// The shape this changes is the MIXED one, where memory_save used to terminate
// a turn whose data-returning call had not been surfaced yet.
//
// A memory-only turn is unaffected — but NOT for the reason this block used to
// give ("it is all-silent, so silentTerminates still ends it"). That mechanism
// is refuted: silentTerminates sits inside the same
// `assistantText.trim().length > 0` gate as mutationTerminates, so the two move
// together. A NARRATED memory-only turn terminates on silentTerminates whatever
// this carve-out answers, and a narration-less one terminates on NEITHER — see
// the paired cases in src/canonical-loop/turn-loop/decide-outcome.test.ts,
// which pin the assistant text as load-bearing rather than incidental.
describe("collectToolFailures — memory writes are bookkeeping, not a terminator", () => {
  const ok = (text: string, toolCallId = "c1") =>
    ({ role: "tool_result" as const, content: { text: `[ok]\n${text}`, toolCallId } });

  it("memory_save counts for the nudge question but NOT for termination", () => {
    const r = collectToolFailures([ok("saved")], [{ tool: "memory_save" }]);
    expect(r.hadSuccessfulMutation).toBe(true);
    expect(r.hadTerminatingMutation).toBe(false);
  });

  it("covers the whole MEMORY_WRITE_TOOLS list, not one name", () => {
    // ITERATE THE EXPORTED SET, never a hand-copy. This used to hardcode five
    // names, so any tool added to silent-tool-check.ts was silently uncovered.
    // Asserting hadSuccessfulMutation too pins the carve-out's premise: every
    // name in the list really is a mutation tool, so excluding it from question
    // B is a decision and not a no-op.
    expect(MEMORY_WRITE_TOOLS.size).toBeGreaterThan(1);
    for (const tool of MEMORY_WRITE_TOOLS) {
      const r = collectToolFailures([ok("done")], [{ tool }]);
      expect({ tool, mutation: r.hadSuccessfulMutation, terminating: r.hadTerminatingMutation })
        .toEqual({ tool, mutation: true, terminating: false });
    }
  });

  it("the stranded-read shape: memory_save + a data-returning call does NOT terminate", () => {
    const r = collectToolFailures(
      [ok("saved", "c1"), ok("nothing to commit, working tree clean", "c2")],
      [{ tool: "memory_save" }, { tool: "bash", toolCallId: "c2" }],
    );
    expect(r.hadTerminatingMutation).toBe(false);
  });

  it("CONTROL: memory_save + a real WRITE still terminates — the carve-out is not a blanket stand-down", () => {
    const r = collectToolFailures(
      [ok("saved", "c1"), ok("wrote /x/y.ts", "c2")],
      [{ tool: "memory_save" }, { tool: "write", toolCallId: "c2" }],
    );
    expect(r.hadTerminatingMutation).toBe(true);
  });

  // DELETE ME WHEN FIXED — pins a KNOWN GAP, not desired behavior.
  // The carve-out reuses silent-tool-check.ts:MEMORY_WRITE_TOOLS, which lists
  // `forget` / `memory_save` but NOT the SEVEN memory_* tools below. Each is
  // workspace-write or destructive in tool-policy/tool-policies.memory.ts, so
  // isMutationTool answers true and hadTerminatingMutation stays true: paired
  // with a data-returning call they still terminate and still strand the
  // result. This test previously named `memory_forget` alone and prescribed a
  // fix that would have closed 1 of 7 — hence the derived-set case below.
  // Fix = add all seven to MEMORY_WRITE_TOOLS (none returns anything the model
  // needs to read back), then delete BOTH tests; the list-coverage case above
  // iterates the Set and picks them up with no further edit.
  const KNOWN_GAP_MEMORY_TOOLS = [
    "memory_consolidate", "memory_dream", "memory_forget", "memory_forget_imports",
    "memory_ingest", "memory_reflect", "memory_reindex",
  ];

  it("KNOWN GAP: seven memory_* mutation tools are absent from MEMORY_WRITE_TOOLS and still terminate", () => {
    for (const tool of KNOWN_GAP_MEMORY_TOOLS) {
      const r = collectToolFailures([ok("done")], [{ tool }]);
      expect({ tool, mutation: r.hadSuccessfulMutation, terminating: r.hadTerminatingMutation })
        .toEqual({ tool, mutation: true, terminating: true });
    }
  });

  it("KNOWN GAP: the pinned list IS the derived gap — an eighth name cannot slip in unnoticed", () => {
    // Derived from the registry rather than restated, so a newly-registered
    // memory_* write tool fails HERE instead of quietly widening the gap.
    const derived = Object.keys(TOOLS)
      .filter(n => n.startsWith("memory_") && isMutationTool(n) && !MEMORY_WRITE_TOOLS.has(n))
      .sort();
    expect(derived).toEqual([...KNOWN_GAP_MEMORY_TOOLS].sort());
  });
});

// C9b item 2 — the third copy of startsWith("task_") is gone. This pins the
// SHARED predicate: committing-tool-check.ts:isLedgerTool is now exported and is
// what both the loop's failure summary and open-steps' opTouchedTaskLedger read.
describe("isLedgerTool — one definition, three decisions", () => {
  it("is exported and answers for the task ledger", () => {
    expect(isLedgerTool("task_create")).toBe(true);
    expect(isLedgerTool("task_update")).toBe(true);
    expect(isLedgerTool("task_list")).toBe(true);
  });

  it("does not swallow real work tools", () => {
    for (const t of ["write", "edit", "bash", "browser", "http_request", "build_app"]) {
      expect({ t, ledger: isLedgerTool(t) }).toEqual({ t, ledger: false });
    }
  });

  // DELETE ME WHEN FIXED — pins the HAZARD documented on isLedgerTool, not
  // desired behavior. The predicate is an unbounded PREFIX match, not a
  // registry lookup, so an active plugin tool registered as `task_*` bypasses
  // the policy table and is silently excluded from termination and from
  // substantive-work credit. Fix = derive from the registry (or reserve the
  // prefix at plugin registration), then delete this test.
  it("KNOWN HAZARD: an unregistered plugin-style `task_*` name is treated as the ledger", () => {
    expect(isLedgerTool("task_zapier_sync_invoices")).toBe(true);
  });
});
