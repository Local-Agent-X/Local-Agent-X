/**
 * Skill-review TRIGGER — the seam between a terminated op and the background
 * review fork (campaign chunk E, decisions D13 / D14 / D15).
 *
 * What must not be wrong here:
 *   1. A tool-heavy chat op queues a review carrying the REAL chat session id
 *      and the whole-op ordered tool sequence.
 *   2. A trivial op queues nothing, so the fork costs nothing on turns it has
 *      nothing to learn from.
 *   3. A BROWSER / external-ingestion session DOES queue. This is D14, the
 *      deliberate divergence from recordCommittedLearningOutcome — that
 *      function's isLearningOutcomeEligible gate refuses every externally
 *      ingesting session, which is every browser session, and a browser
 *      workflow is the exact thing this feature exists to capture. Pinned so
 *      nobody "fixes" it back later.
 *   4. DURABILITY: nothing is queued until the terminal turn is committed. A
 *      transcript read before commit is missing the whole final turn, and on a
 *      terminal turn 0 it is missing every step while the tool sequence still
 *      claims a multi-step workflow — the fork would author a playbook out of
 *      nothing. Cancel, lease loss, deadline and a throwing commit all land
 *      there.
 *   5. Only USER-FACING ops. Delegated/cron/worker ops inherit the parent chat
 *      session id, and the queue coalesces per session, so an unfiltered
 *      trigger lets a machine transcript overwrite the user's real
 *      conversation under the same key.
 *   6. A transcript render failure never reaches the user's turn.
 *   7. The dead `long-task-completed` nudge slot actually fires.
 *   8. Secrets do not survive the per-entry clip.
 *
 * F16: BOTH `LAX_DATA_DIR` and the runtime config's `workspace` are pinned to
 * temp dirs for the whole file, before any src module is imported. The trigger
 * reaches store reads, the outcome ledger and (through the queue's dynamic
 * import) the protocol modules; an unpinned run reads and migrates the user's
 * real ~/.lax and workspace/protocols. `workspace/` is NOT git-tracked, so
 * anything lost there is unrecoverable — this file therefore only ever points
 * at temp dirs and never removes anything outside the two it created.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../src/config.js";
import type { LAXConfig } from "../src/types.js";

const TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-skillreview-trigger-"));
const TEMP_WORKSPACE = mkdtempSync(join(tmpdir(), "lax-skillreview-trigger-ws-"));
const ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
const ORIGINAL_CFG = getRuntimeConfig();
process.env.LAX_DATA_DIR = TEMP_LAX;
setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP_WORKSPACE } as LAXConfig);

// ── Fixture store ──
// The seam consumes op_turns (the tool sequence + the durability signal) and
// op_messages (the transcript). Both come from the canonical store; driving
// them from fixtures keeps the test about the TRIGGER rather than turn-commit
// plumbing, and lets `commit()` model the one thing that matters here — that
// commitTurn is the only writer of BOTH, so before it runs neither exists.
interface FixtureRow { turnIdx: number; seqInTurn: number; role: string; content: unknown; messageId: string }
interface FixtureTurn { turnIdx: number; toolCallSummary?: Array<{ tool: string }>; observedTools?: string[]; terminalReason: string | null }

const store: { turns: FixtureTurn[]; messages: FixtureRow[]; messagesThrow: boolean } = {
  turns: [], messages: [], messagesThrow: false,
};
/** Staged (pre-commit) op state — invisible to readers until commit(). */
const staged: { turns: FixtureTurn[]; messages: FixtureRow[] } = { turns: [], messages: [] };

vi.mock("../src/canonical-loop/store.js", () => ({
  readOpTurns: () => store.turns,
  readOpMessages: () => {
    if (store.messagesThrow) throw new Error("simulated turn-artifact read failure");
    return store.messages;
  },
}));

/** What commitTurn does for us: publish the staged turn + its messages. */
function commit(): void {
  store.turns = [...staged.turns];
  store.messages = [...staged.messages];
}

const sessionForOp = { value: "" };
vi.mock("../src/ops/session-bridge.js", () => ({
  getSessionForOp: () => sessionForOp.value || undefined,
}));

// Keep the outcome ledger and model resolution off disk — neither is under
// test here and both are exercised by decide-outcome.test.ts.
vi.mock("../src/canonical-loop/op-model.js", () => ({ resolveOpModel: () => "test-model" }));
vi.mock("../src/tool-tracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tool-tracker.js")>()),
  recordOpOutcome: vi.fn(),
}));
vi.mock("../src/cognition/cross-session-learning/index.js", () => ({
  default: { recordOutcome: vi.fn() },
}));

const { requestSkillReviewForOp } =
  await import("../src/canonical-loop/turn-loop/record-outcome.js");
const { renderOpTranscript } = await import("../src/canonical-loop/turn-loop/op-transcript.js");
const { peekSkillReviewQueue, _resetSkillReviewQueue } =
  await import("../src/server/background-jobs/skill-review.js");
const { hasCurateSignal, resetSession } = await import("../src/memory/curate-nudge.js");
const { recordExternalIngestion, clearExternalIngestion } =
  await import("../src/data-lineage/external.js");
const { registerRedactedSecretValue, unregisterRedactedSecretValue } =
  await import("../src/sanitize.js");
import type { Op } from "../src/ops/types.js";

function chatOp(over: Partial<Op> = {}): Op {
  return { id: "op-trigger-test", type: "chat_turn", lane: "interactive", ownerId: "local-user", ...over } as unknown as Op;
}

/** Wait out the trigger's setImmediate hop plus the dynamic import it awaits. */
async function flushTrigger(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function msg(over: Partial<FixtureRow>): FixtureRow {
  return { turnIdx: 0, seqInTurn: 0, role: "assistant", content: {}, messageId: `m${Math.random()}`, ...over };
}

/** A browser purchase-order run: ordered, multi-tool, with a user correction —
 *  the campaign's motivating shape. */
function purchaseOrderMessages(): FixtureRow[] {
  return [
    msg({ role: "user", seqInTurn: 0, content: { text: "create the PO in thriveventory from this invoice" } }),
    msg({
      role: "assistant", seqInTurn: 1,
      content: {
        text: "Opening Thriveventory.",
        toolCalls: [{ id: "c1", name: "browser", arguments: JSON.stringify({ action: "navigate", url: "https://app.thriveventory.com/purchase-orders" }) }],
      },
    }),
    msg({ role: "tool_result", seqInTurn: 2, content: { toolCallId: "c1", text: "navigated" } }),
    msg({
      role: "assistant", seqInTurn: 3,
      content: { toolCalls: [{ id: "c2", name: "browser", arguments: JSON.stringify({ action: "click", selector: "#ai-import" }) }] },
    }),
    msg({ role: "tool_result", seqInTurn: 4, content: { toolCallId: "c2", text: "clicked" } }),
    msg({ role: "user", seqInTurn: 5, content: { text: "no — never the AI import, use External/Create PO manually" } }),
    msg({
      role: "assistant", seqInTurn: 6,
      content: { toolCalls: [{ id: "c3", name: "browser", arguments: JSON.stringify({ action: "click", selector: "button[data-testid='external-create-po']" }) }] },
    }),
    msg({ role: "tool_result", seqInTurn: 7, content: { toolCallId: "c3", text: "modal open" } }),
    msg({
      role: "assistant", seqInTurn: 8,
      content: { text: "PO created.", toolCalls: [{ id: "c4", name: "remember", arguments: JSON.stringify({ fact: "PO# comes from the invoice" }) }] },
    }),
    msg({ role: "tool_result", seqInTurn: 9, content: { toolCallId: "c4", text: "saved" } }),
  ];
}

/**
 * The committed shape of that op.
 *
 * Turn 0 alone deliberately clears the review bar (>=4 calls, >=2 distinct).
 * That is what makes the durability tests below load-bearing: with a
 * review-worthy sequence already on disk, the ONLY thing standing between an
 * uncommitted terminal turn and a queued review is the durability guard. Give
 * turn 0 a trivial sequence instead and those tests pass for the wrong reason —
 * the triviality gate refuses first and the guard is never exercised.
 */
function purchaseOrderTurns(): FixtureTurn[] {
  return [
    {
      turnIdx: 0,
      toolCallSummary: [{ tool: "browser" }, { tool: "browser" }, { tool: "browser" }, { tool: "remember" }],
      observedTools: [], terminalReason: null,
    },
    { turnIdx: 1, toolCallSummary: [{ tool: "browser" }, { tool: "remember" }], observedTools: [], terminalReason: "done" },
  ];
}
const PO_SEQUENCE = ["browser", "browser", "browser", "remember", "browser", "remember"];
/** Turn 0 on its own — already review-worthy. */
const PRE_COMMIT_SEQUENCE = ["browser", "browser", "browser", "remember"];
/** The index of the turn whose commit drives the trigger. */
const TERMINAL_TURN = 1;

/** Stage a completed purchase-order op WITHOUT committing it. */
function stagePurchaseOrder(): void {
  staged.turns = purchaseOrderTurns();
  staged.messages = purchaseOrderMessages();
}

beforeAll(() => {
  // Assert the pins rather than assuming them: an unpinned run of this file
  // reads (and migrates) the user's real, un-git-tracked protocol catalog.
  expect(process.env.LAX_DATA_DIR).toBe(TEMP_LAX);
  expect(getRuntimeConfig().workspace).toBe(TEMP_WORKSPACE);
});

beforeEach(() => {
  _resetSkillReviewQueue();
  store.turns = [];
  store.messages = [];
  store.messagesThrow = false;
  staged.turns = [];
  staged.messages = [];
  sessionForOp.value = "";
  resetSession("sess-chat");
  resetSession("sess-browser");
  clearExternalIngestion("sess-browser");
});

afterAll(() => {
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
  setRuntimeConfig(ORIGINAL_CFG);
  // Only the two dirs this file created, by absolute path, and only after
  // re-checking they are the temp ones we made.
  if (TEMP_LAX.includes("lax-skillreview-trigger-")) rmSync(TEMP_LAX, { recursive: true, force: true });
  if (TEMP_WORKSPACE.includes("lax-skillreview-trigger-ws-")) rmSync(TEMP_WORKSPACE, { recursive: true, force: true });
});

describe("skill-review trigger — enqueue decision", () => {
  it("a tool-heavy chat op queues a review with the real session id and the ordered sequence", async () => {
    stagePurchaseOrder();
    commit();
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();

    const queued = peekSkillReviewQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].sessionId).toBe("sess-chat");
    expect([...queued[0].toolSequence]).toEqual(PO_SEQUENCE);
    expect(queued[0].transcript).toContain("external-create-po");
  });

  it("a trivial op queues nothing", async () => {
    staged.turns = [{ turnIdx: 0, toolCallSummary: [{ tool: "read" }, { tool: "read" }], observedTools: [], terminalReason: "done" }];
    staged.messages = purchaseOrderMessages();
    commit();
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);
  });

  it("an op with no session binding queues nothing", async () => {
    stagePurchaseOrder();
    commit();
    requestSkillReviewForOp(chatOp(), "", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);
  });

  // ── D14 ──
  it("a BROWSER / external-ingestion session still queues (D14 — deliberate)", async () => {
    recordExternalIngestion("sess-browser");
    stagePurchaseOrder();
    commit();
    requestSkillReviewForOp(chatOp(), "sess-browser", TERMINAL_TURN);
    await flushTrigger();

    const queued = peekSkillReviewQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].sessionId).toBe("sess-browser");
  });
});

// ── R1: durability ──
describe("skill-review trigger — durability (never review an uncommitted turn)", () => {
  /** Publish everything EXCEPT the terminal turn row: the exact state a
   *  pre-commit trigger observes on the last turn of a multi-turn op, and the
   *  state a cancel / lease loss / deadline / throwing commitTurn leaves behind
   *  permanently. The committed prefix is already review-worthy, so nothing but
   *  the durability guard can refuse here. */
  function publishAllButTerminalTurn(): void {
    store.turns = staged.turns.filter((t) => t.terminalReason === null);
    store.messages = [...staged.messages];
  }

  it("the committed prefix alone would otherwise pass the review bar", async () => {
    // Guards the guard: if this stops holding, the durability tests below start
    // passing because the turn was TRIVIAL, not because it was uncommitted.
    stagePurchaseOrder();
    publishAllButTerminalTurn();
    // Same rows, but turn 0 IS the committing terminal turn.
    store.turns = [{ ...staged.turns[0], terminalReason: "done" }];
    requestSkillReviewForOp(chatOp(), "sess-chat", 0);
    await flushTrigger();
    const queued = peekSkillReviewQueue();
    expect(queued).toHaveLength(1);
    expect([...queued[0].toolSequence]).toEqual(PRE_COMMIT_SEQUENCE);
  });

  it("is scoped to the COMMITTING turn, not to any terminal row on the op", async () => {
    // An op-wide "some terminal row exists" check is satisfied by an earlier
    // terminal row, which makes the durability property accidental rather than
    // checked. Turn 0 is terminal and review-worthy here; turn 1 never
    // committed, so the turn under review is not durable and must be refused.
    stagePurchaseOrder();
    store.turns = [{ ...staged.turns[0], terminalReason: "done" }];
    store.messages = [...staged.messages];
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);
  });

  it("queues nothing when the terminal turn was never committed", async () => {
    stagePurchaseOrder();
    publishAllButTerminalTurn();
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);
  });

  it("queues once the commit lands, with the whole op", async () => {
    stagePurchaseOrder();
    publishAllButTerminalTurn();
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);

    commit();
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    const queued = peekSkillReviewQueue();
    expect(queued).toHaveLength(1);
    expect([...queued[0].toolSequence]).toEqual(PO_SEQUENCE);
    expect(queued[0].transcript).toContain("[TOOL] browser");
  });

  it("an op with nothing committed at all queues nothing (triviality gate refuses first)", async () => {
    // The terminal-turn-0 shape: readOpTurns is [] pre-commit and op_messages
    // holds only the seeded user message, so a trigger firing here would hand
    // the fork a request with ZERO steps and tell it to write a playbook.
    //
    // Titled for what it PINS, not for what motivated it: with no committed
    // turns the sequence is empty, so the triviality gate refuses before the
    // durability guard is ever consulted, and this test survives deleting that
    // guard. The tests above are the ones that pin it.
    store.turns = [];
    store.messages = [msg({ role: "user", seqInTurn: 0, content: { text: "create the PO in thriveventory" } })];
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);
  });
});

// ── R2: user-facing ops only ──
describe("skill-review trigger — user-facing ops only", () => {
  beforeEach(() => {
    stagePurchaseOrder();
    commit();
  });

  it("queues for a chat turn and a voice turn", async () => {
    requestSkillReviewForOp(chatOp({ type: "chat_turn" }), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(1);

    _resetSkillReviewQueue();
    requestSkillReviewForOp(chatOp({ type: "voice_turn" }), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(1);
  });

  it.each(["research", "build_app", "self_edit", "freeform", "agent_spawn", "cron_run"])(
    "does NOT queue for a delegated/background op of type %s",
    async (type) => {
      // Delegated ops inherit the PARENT chat session id
      // (ops/tools/shared.ts delegatedRuntimeSessionId), and chunk D's queue
      // coalesces per session — so this would overwrite the user's real
      // conversation with a machine worker transcript, and buy a main-model
      // review of it.
      requestSkillReviewForOp(chatOp({ type, lane: "background" }), "sess-chat", TERMINAL_TURN);
      await flushTrigger();
      expect(peekSkillReviewQueue()).toHaveLength(0);
    },
  );

  it("does NOT queue for a spawned op that named itself chat_turn", async () => {
    requestSkillReviewForOp(chatOp({ type: "chat_turn", parentOpId: "op-parent" }), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);
  });

  it("a delegated op cannot overwrite the chat op's queued review", async () => {
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()[0].transcript).toContain("external-create-po");

    // The worker terminates later, under the SAME session id.
    store.messages = [
      msg({ role: "user", seqInTurn: 0, content: { text: "WORKER TASK: summarize the repo" } }),
      msg({ role: "assistant", seqInTurn: 1, content: { toolCalls: [{ id: "w1", name: "grep", arguments: "{}" }] } }),
    ];
    requestSkillReviewForOp(chatOp({ id: "op-worker", type: "research", lane: "background" }), "sess-chat", TERMINAL_TURN);
    await flushTrigger();

    const queued = peekSkillReviewQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].transcript).toContain("external-create-po");
    expect(queued[0].transcript).not.toContain("WORKER TASK");
  });
});

describe("skill-review trigger — non-fatal", () => {
  /** The trigger body runs as `void asyncFn()` inside a setImmediate callback,
   *  so a throw there is an unhandled rejection — fatal to the process under
   *  Node's default policy, i.e. the server dies mid-conversation. Nothing in
   *  the assertion suite would notice that on its own, so watch for it. */
  async function withNoUnhandledRejection(body: () => Promise<void>): Promise<void> {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => { seen.push(reason); };
    const onException = (err: unknown): void => { seen.push(err); };
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
    try {
      await body();
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    }
    expect(seen.map((e) => (e as Error)?.message ?? String(e))).toEqual([]);
  }

  it("a transcript render failure neither throws, crashes, nor queues", async () => {
    await withNoUnhandledRejection(async () => {
      stagePurchaseOrder();
      commit();
      store.messagesThrow = true;
      expect(() => requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN)).not.toThrow();
      await flushTrigger();
      expect(peekSkillReviewQueue()).toHaveLength(0);
    });
  });

  it("the nudge boost survives a transcript render failure", async () => {
    await withNoUnhandledRejection(async () => {
      stagePurchaseOrder();
      commit();
      store.messagesThrow = true;
      requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
      await flushTrigger();
      expect(hasCurateSignal("sess-chat")).toBe(true);
    });
  });
});

// ── F5 / D15 ──
describe("skill-review trigger — long-task-completed nudge (F5)", () => {
  it("fires the dead trigger slot on a tool-heavy op", async () => {
    expect(hasCurateSignal("sess-chat")).toBe(false);
    stagePurchaseOrder();
    commit();
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    // hasCurateSignal is the real downstream consumer — it gates the memory
    // end-of-turn extraction pass (memory/extraction-coalescer.ts).
    expect(hasCurateSignal("sess-chat")).toBe(true);
  });

  it("does not fire on a trivial op", async () => {
    staged.turns = [{ turnIdx: 0, toolCallSummary: [{ tool: "read" }], observedTools: [], terminalReason: "done" }];
    staged.messages = purchaseOrderMessages();
    commit();
    requestSkillReviewForOp(chatOp(), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(hasCurateSignal("sess-chat")).toBe(false);
  });

  it("does not fire for a delegated op", async () => {
    stagePurchaseOrder();
    commit();
    requestSkillReviewForOp(chatOp({ type: "research", lane: "background" }), "sess-chat", TERMINAL_TURN);
    await flushTrigger();
    expect(hasCurateSignal("sess-chat")).toBe(false);
  });
});

describe("transcript rendering", () => {
  it("carries the arguments and corrections a playbook is made of, not just tool names", () => {
    store.messages = purchaseOrderMessages();
    const text = renderOpTranscript("op-trigger-test");

    expect(text).toContain("https://app.thriveventory.com/purchase-orders");
    expect(text).toContain("button[data-testid='external-create-po']");
    expect(text).toContain("never the AI import");
    expect(text.indexOf("#ai-import")).toBeLessThan(text.indexOf("external-create-po"));
    expect(text).toContain("[RESULT browser]");
  });

  it("bounds the transcript and keeps both ends of the procedure", () => {
    const many: FixtureRow[] = [
      msg({ role: "user", seqInTurn: 0, content: { text: "FIRST-STEP-MARKER open the console" } }),
    ];
    for (let i = 0; i < 400; i++) {
      many.push(msg({
        role: "assistant", seqInTurn: i * 2 + 1,
        content: {
          text: "x".repeat(2000),
          toolCalls: [{ id: `t${i}`, name: "browser", arguments: JSON.stringify({ selector: `#row-${i}`, filler: "y".repeat(2000) }) }],
        },
      }));
      many.push(msg({ role: "tool_result", seqInTurn: i * 2 + 2, content: { toolCallId: `t${i}`, text: "z".repeat(4000) } }));
    }
    many.push(msg({ role: "user", seqInTurn: 9999, content: { text: "LAST-STEP-MARKER now save it" } }));
    store.messages = many;

    const text = renderOpTranscript("op-trigger-test");
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).toContain("FIRST-STEP-MARKER");
    expect(text).toContain("LAST-STEP-MARKER");
    expect(text).toContain("entries omitted");
    expect(text).not.toContain("y".repeat(500));
  });

  // Marker inflation: budgeting the dropped entry but not the omission marker
  // let dropping GROW the output, which drove the convergence loop to empty on
  // exactly the longest ops — and badly under-used the budget on the rest.
  it.each([800, 1600, 3200, 6400])("uses the budget on an op with %i short entries", (n) => {
    const rows: FixtureRow[] = [msg({ role: "user", seqInTurn: 0, content: { text: "HEAD-MARKER start" } })];
    for (let i = 0; i < n; i++) {
      rows.push(msg({
        role: "assistant", seqInTurn: i * 2 + 1,
        content: { text: `step ${i}`, toolCalls: [{ id: `t${i}`, name: "browser", arguments: `{"n":${i}}` }] },
      }));
      rows.push(msg({ role: "tool_result", seqInTurn: i * 2 + 2, content: { toolCallId: `t${i}`, text: "ok" } }));
    }
    rows.push(msg({ role: "user", seqInTurn: 999999, content: { text: "TAIL-MARKER done" } }));
    store.messages = rows;

    const text = renderOpTranscript("op-trigger-test");
    expect(text.length).toBeLessThanOrEqual(12_000);
    // Not empty, and not a token gesture: most of the budget is content.
    expect(text.length).toBeGreaterThan(9_000);
    expect(text).toContain("HEAD-MARKER");
    expect(text).toContain("TAIL-MARKER");
    // EXACTLY one contiguous gap. Scattered markers are what ate the budget
    // (and then the whole transcript) before the fit was rewritten.
    expect(text.split("entries omitted").length - 1).toBe(1);
  });

  it("redacts secrets", () => {
    store.messages = [
      msg({
        role: "assistant", seqInTurn: 0,
        content: { toolCalls: [{ id: "s1", name: "http_request", arguments: JSON.stringify({ headers: { Authorization: "Bearer abcdefghijklmnop1234567890" } }) }] },
      }),
      msg({ role: "tool_result", seqInTurn: 1, content: { toolCallId: "s1", text: "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }),
    ];
    const text = renderOpTranscript("op-trigger-test");
    expect(text).not.toContain("abcdefghijklmnop1234567890");
    expect(text).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  // ── R3 ──
  it("redacts a registered secret that STRADDLES the per-entry clip", () => {
    // Clip-then-redact is a leak: both redactors match complete values, so the
    // head of a secret cut by the clip matches nothing and survives — into the
    // transcript and from there into a git-synced protocol body.
    // The arithmetic is exact on purpose. Clip-then-redact leaks precisely the
    // prefix that fits before the clip, so the assertion has to name THAT
    // prefix — a longer one passes even while the credential is leaking, which
    // is how the first version of this test let the bug through.
    const LEAK = 22;
    const secret = "hunter2-VERY-SECRET-VAULT-VALUE-9f3a2b7c";
    registerRedactedSecretValue(secret);
    try {
      // Args clip is 400. `{"v":"` is 6 chars, so this pad puts exactly the
      // first LEAK characters of the secret before the cut.
      const pad = "p".repeat(400 - 6 - LEAK);
      store.messages = [
        msg({
          role: "assistant", seqInTurn: 0,
          content: { toolCalls: [{ id: "b1", name: "browser", arguments: `{"v":"${pad}${secret}"}` }] },
        }),
      ];
      const argsText = renderOpTranscript("op-trigger-test");
      expect(argsText).toContain("[TOOL] browser");
      expect(argsText).not.toContain(secret.slice(0, LEAK));

      // Same for a shape-catalog secret, across the 300-char result clip.
      //
      // The fragment must be one the catalog CANNOT match on its own, or the
      // whole-transcript pass mops it up and the test proves nothing about
      // per-entry ordering. A Bearer token is the clean case: the pattern needs
      // 16+ token characters, so the full header matches and a 14-char remnant
      // does not. (A long API key fails as a fixture here — any 22-char slice
      // of one is itself high-entropy and gets caught downstream.) The catalog
      // is also word-boundary anchored, hence the real separator.
      const FRAG = 14;
      const token = "Zx9Qw3Er7TyU1iOp2aSd4fGh6jKl8zXc";
      const header = " Authorization: Bearer "; // 23 chars
      store.messages = [
        msg({
          role: "assistant", seqInTurn: 0,
          content: { toolCalls: [{ id: "b2", name: "bash", arguments: "{}" }] },
        }),
        msg({ role: "tool_result", seqInTurn: 1, content: { toolCallId: "b2", text: "q".repeat(300 - header.length - FRAG) + header + token } }),
      ];
      const resultText = renderOpTranscript("op-trigger-test");
      expect(resultText).toContain("[RESULT bash]");
      expect(resultText).not.toContain(token.slice(0, FRAG));
    } finally {
      unregisterRedactedSecretValue(secret);
    }
  });

  // A hand-registered human passphrase has NO detectable shape, so the shape
  // catalog cannot rescue a partial match the way it does for a high-entropy
  // token — the known-value pass is the only thing that can catch it, and a
  // positional (windowed) known-value pass misses it entirely. Whitespace is
  // what does the damage: collapsing it moves the secret relative to any
  // window measured on the raw text.
  it("redacts a shapeless passphrase pushed past the secret window by whitespace", () => {
    const passphrase = "correcthorsebatterystaple";
    registerRedactedSecretValue(passphrase);
    try {
      // Result clip is 300, window is 2048. "start" (5) + the gap puts the
      // passphrase's first 18 characters inside the window and the rest
      // outside it; collapsing then pulls that fragment back under the clip,
      // where nothing positional will ever see the whole value. (The gap must
      // follow real content — a LEADING run is trimmed before the window is
      // measured, which is why the first version of this fixture proved
      // nothing.)
      const gap = " ".repeat(300 + 2048 - 5 - 18);
      store.messages = [
        msg({ role: "assistant", seqInTurn: 0, content: { toolCalls: [{ id: "p1", name: "bash", arguments: "{}" }] } }),
        msg({ role: "tool_result", seqInTurn: 1, content: { toolCallId: "p1", text: `start${gap}${passphrase} done` } }),
      ];
      const text = renderOpTranscript("op-trigger-test");
      expect(text).toContain("[RESULT bash] start");
      expect(text).not.toContain(passphrase.slice(0, 15));
    } finally {
      unregisterRedactedSecretValue(passphrase);
    }
  });

  // The post-redaction convergence loop: redaction can GROW text (a short
  // registered value becomes "[REDACTED_SECRET]"), and the fix for that must
  // not be a tail slice — the tail is the correction and what finally worked.
  it("stays under the cap when redaction grows the text, without cutting the tail", () => {
    // >=6 chars with >=4 distinct, or isSecretShaped rejects the registration
    // (known-secrets.ts). 7 chars in, 18 out — redaction inflates ~2.5x.
    const shorty = "a1b2c3d";
    registerRedactedSecretValue(shorty);
    try {
      const rows: FixtureRow[] = [msg({ role: "user", seqInTurn: 0, content: { text: "HEAD-MARKER go" } })];
      for (let i = 0; i < 300; i++) {
        rows.push(msg({
          role: "assistant", seqInTurn: i + 1,
          // Every arg is a dense run of the registered value: 3 chars each
          // become 18, so redaction inflates this transcript ~6x.
          content: { toolCalls: [{ id: `g${i}`, name: "browser", arguments: `${shorty} `.repeat(30) }] },
        }));
      }
      rows.push(msg({ role: "user", seqInTurn: 999999, content: { text: "TAIL-MARKER stop" } }));
      store.messages = rows;

      const text = renderOpTranscript("op-trigger-test");
      expect(text.length).toBeLessThanOrEqual(12_000);
      expect(text).toContain("TAIL-MARKER");
      expect(text).not.toContain(shorty);
    } finally {
      unregisterRedactedSecretValue(shorty);
    }
  });
});
