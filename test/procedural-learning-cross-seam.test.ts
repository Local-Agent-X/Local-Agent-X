/**
 * Procedural-learning loop — CROSS-SEAM contract (campaign chunk H).
 *
 * Every chunk of this campaign is green on its own. This file exists because
 * per-chunk green is necessary and not sufficient: the failures this repo keeps
 * paying for live BETWEEN chunks, where each side is individually correct and
 * the pair is not. Four seams are pinned here and nowhere else.
 *
 * (a) D3 — the memory end-of-turn pass and the skill-review pass cannot starve
 *     each other. Both are triggered from the same turn-terminal region. The
 *     memory path runs through memory/extraction-coalescer.ts (per-session
 *     state, one `inProgress` flag, one `pending` slot, latest-wins); the skill
 *     path through background-jobs/skill-review.ts's own queue. They share
 *     exactly one mutable thing — curate-nudge's per-session state — and the
 *     coupling is one-way: the skill TRIGGER boosts `long-task-completed`,
 *     which is what opens the memory pass's gate. Anything that made that
 *     coupling two-way, or that let one pass block on the other, is starvation.
 *     This was the one done-list item with no coverage.
 *
 * (b) The write→read loop closes. A protocol authored through the fork's own
 *     narrowed `protocol` tool → authorProtocol() → custom.json is subsequently
 *     SURFACED by getLearnedProtocolSuggestion for a matching request. That is
 *     the campaign's entire premise, and chunk D tests only the write half
 *     while chunk F tests only the read half against hand-built fixtures.
 *
 * (c) Provenance survives the whole path — authored agent → persisted → loaded
 *     → surfaced → archived → unarchived → surfaced again, still "agent".
 *     protocols-archive.test.ts covers store→store; the retrieval hops are new.
 *
 * (d) The trigger's guards hold AT THE SEAM: a refused trigger schedules
 *     NEITHER pass, and an accepted one schedules exactly one review under the
 *     real chat session id. skill-review-trigger.test.ts asserts the skill half;
 *     the memory half of the same decision is what makes it cross-seam.
 *
 * ── F16, mandatory ──
 * BOTH `process.env.LAX_DATA_DIR` and `getRuntimeConfig().workspace` are pinned
 * to temp dirs before any src module that reads them is imported, and both pins
 * are asserted in beforeAll rather than assumed. An unpinned run reaches
 * runProtocolMigrations(), which `renameSync`s the contents of ~/.lax/skills
 * into the workspace — here a temp dir this file deletes. `workspace/` is not
 * git-tracked, so that loss is unrecoverable. afterAll removes only the two
 * dirs this file created, by absolute path, after re-checking their names.
 *
 * No real model is ever called: runAgentViaCanonical and
 * runEndOfTurnMemoryWrite are both mocked at their module boundary. Everything
 * between them is production code.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../src/config.js";
import type { LAXConfig, ToolDefinition } from "../src/types.js";

const TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-xseam-laxdir-"));
const TEMP_WORKSPACE = mkdtempSync(join(tmpdir(), "lax-xseam-ws-"));
const ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
const ORIGINAL_CFG = getRuntimeConfig();
process.env.LAX_DATA_DIR = TEMP_LAX;
setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP_WORKSPACE } as LAXConfig);

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  resolveProvider: vi.fn(),
  runEndOfTurn: vi.fn(),
}));

// The two model boundaries. Nothing past these is mocked.
vi.mock("../src/canonical-loop/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAgentViaCanonical: mocks.runAgent,
}));
vi.mock("../src/agent-request/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProvider: mocks.resolveProvider,
}));
vi.mock("../src/memory/end-of-turn-write.js", () => ({
  runEndOfTurnMemoryWrite: mocks.runEndOfTurn,
}));

// ── Fixture op store ──
// The trigger consumes op_turns (tool sequence + the durability signal) and
// op_messages (the transcript). Driving both from fixtures keeps this file
// about the SEAMS rather than about turn-commit plumbing, and lets commit()
// model the one property that matters: commitTurn is the sole writer of both,
// so before it runs neither exists.
interface FixtureRow { turnIdx: number; seqInTurn: number; role: string; content: unknown; messageId: string }
interface FixtureTurn { turnIdx: number; toolCallSummary?: Array<{ tool: string }>; terminalReason: string | null }

const store: { turns: FixtureTurn[]; messages: FixtureRow[] } = { turns: [], messages: [] };
vi.mock("../src/canonical-loop/store.js", () => ({
  readOpTurns: () => store.turns,
  readOpMessages: () => store.messages,
}));

// Deterministic and off disk. The learned tier is not what this file is about;
// an empty candidate list makes every suggestion below attributable to the
// custom tier the fork actually writes.
vi.mock("../src/cognition/cross-session-learning/index.js", () => ({
  default: { recordOutcome: vi.fn(), getCandidates: () => [] },
}));

const { requestSkillReviewForOp } = await import("../src/canonical-loop/turn-loop/record-outcome.js");
const {
  requestSkillReview, runSkillReviewPass, registerSkillReviewRunner,
  peekSkillReviewQueue, buildReviewTools, _resetSkillReviewQueue,
} = await import("../src/server/background-jobs/skill-review.js");
const { requestEndOfTurnExtraction, drainPendingExtractions, _internals: coalescer } =
  await import("../src/memory/extraction-coalescer.js");
const { hasCurateSignal, resetSession, _internals: nudge } =
  await import("../src/memory/curate-nudge.js");
const { getLastWriteTick } = await import("../src/memory/write-safely.js");
const { createProtocol, loadCustomProtocols, saveCustomProtocols, editProtocol } =
  await import("../src/protocols/builder.js");
const { getAllProtocols } = await import("../src/protocols/index.js");
const { archiveProtocol, unarchiveProtocol } = await import("../src/protocols/archive.js");
const { getLearnedProtocolSuggestion } = await import("../src/protocols/learned-suggestion.js");
import type { Op } from "../src/ops/types.js";
import type { SkillReviewDeps } from "../src/server/background-jobs/skill-review.js";
import type { EndOfTurnContext } from "../src/memory/end-of-turn-write.js";
import type { MemoryIndex } from "../src/memory/index-core.js";
import type { Protocol } from "../src/protocols/types.js";

// ── Session ids used across the file ──
const CHAT = "sess-xseam-chat";
const OTHER = "sess-xseam-other";

// ── The motivating shape: a browser purchase-order run ──
const PO_TOOLS = ["browser", "browser", "browser", "remember", "browser", "remember"];
const TERMINAL_TURN = 1;

function msg(over: Partial<FixtureRow>): FixtureRow {
  return { turnIdx: 0, seqInTurn: 0, role: "assistant", content: {}, messageId: `m${Math.random()}`, ...over };
}

function poMessages(): FixtureRow[] {
  return [
    msg({ role: "user", seqInTurn: 0, content: { text: "create the PO in thriveventory from this invoice" } }),
    msg({
      role: "assistant", seqInTurn: 1,
      content: { toolCalls: [{ id: "c1", name: "browser", arguments: JSON.stringify({ action: "navigate", url: "https://app.thriveventory.com/purchase-orders" }) }] },
    }),
    msg({ role: "tool_result", seqInTurn: 2, content: { toolCallId: "c1", text: "navigated" } }),
    msg({ role: "user", seqInTurn: 3, content: { text: "no — never the AI import, use External/Create PO manually" } }),
    msg({
      role: "assistant", seqInTurn: 4,
      content: { toolCalls: [{ id: "c2", name: "browser", arguments: JSON.stringify({ selector: "button[data-testid='external-create-po']" }) }] },
    }),
    msg({ role: "tool_result", seqInTurn: 5, content: { toolCallId: "c2", text: "modal open" } }),
  ];
}

/** Turn 0 alone already clears the review bar (>=4 calls, >=2 distinct tools).
 *  That is deliberate: it means the durability guard, not the triviality gate,
 *  is what refuses an uncommitted terminal turn below. */
function poTurns(): FixtureTurn[] {
  return [
    { turnIdx: 0, toolCallSummary: [{ tool: "browser" }, { tool: "browser" }, { tool: "browser" }, { tool: "remember" }], terminalReason: null },
    { turnIdx: 1, toolCallSummary: [{ tool: "browser" }, { tool: "remember" }], terminalReason: "done" },
  ];
}

function commitPurchaseOrderOp(): void {
  store.turns = poTurns();
  store.messages = poMessages();
}

/** The same op left uncommitted on its terminal turn — what a cancel, a lease
 *  loss, a deadline, or a throwing commitTurn leaves behind permanently. */
function stagePurchaseOrderUncommitted(): void {
  store.turns = poTurns().filter((t) => t.terminalReason === null);
  store.messages = poMessages();
}

function chatOp(over: Partial<Op> = {}): Op {
  return { id: "op-xseam", type: "chat_turn", lane: "interactive", ownerId: "local-user", ...over } as unknown as Op;
}

/** Wait out the trigger's setImmediate hop plus the dynamic import it awaits. */
async function flushTrigger(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function eotCtx(over: Partial<EndOfTurnContext> = {}): EndOfTurnContext {
  return {
    sessionId: CHAT,
    userMessage: "create the PO in thriveventory from this invoice",
    assistantReply: "done",
    memory: {} as unknown as MemoryIndex,
    ...over,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function stubTool(name: string): ToolDefinition {
  return { name, description: `stub ${name}`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) };
}

/**
 * A `protocol` base tool wired to the REAL edit primitive.
 *
 * The fork's create path never reaches the base tool (it goes straight to
 * authorProtocol), but its EDIT path delegates, so the base has to actually
 * persist or the patch half of the loop cannot be observed end to end. This
 * mirrors what the collapsed `protocol` family's edit action does; assembling
 * the real family would drag in the whole tool registry for no added coverage
 * of the seam under test.
 */
const writingProtocolBase: ToolDefinition = {
  name: "protocol",
  description: "base",
  parameters: { type: "object", properties: {} },
  execute: async (args) => {
    const p = args.params as { name: string; updates: Partial<Protocol> };
    editProtocol(p.name, p.updates);
    return { content: "edited" };
  },
};

function fakeDeps(over: Partial<SkillReviewDeps> = {}): SkillReviewDeps {
  return {
    config: getRuntimeConfig(),
    dataDir: TEMP_LAX,
    secretsStore: {},
    security: {},
    toolPolicy: {},
    allAgentTools: [writingProtocolBase, stubTool("bash")],
    ...over,
  } as unknown as SkillReviewDeps;
}

/** Script the fork's "model": run these tool calls against the narrowed tool
 *  list canonical was handed, then return a turn with no further calls. */
function forkCalls(...calls: Array<Record<string, unknown>>): void {
  mocks.runAgent.mockImplementation(async (_m: string, _h: unknown, opts: { tools: ToolDefinition[] }) => {
    for (const call of calls) await opts.tools[0].execute(call);
    return { messages: [] };
  });
}

/** The protocol the fork writes in the write→read tests. */
const PO_CREATE = {
  action: "create",
  params: {
    name: "thriveventory_purchase_order",
    description: "Create a purchase order in Thriveventory from a supplier invoice",
    triggers: ["thriveventory purchase order", "thrive po from invoice"],
    body: "## Preconditions\n- Logged into Thriveventory\n\n## Steps\n1. External > Create PO — never the AI import.",
  },
};
/** A request phrased the way the user actually phrases it. Distinctive terms:
 *  file / thriveventory / purchase / order / vendor / invoice. */
const PO_REQUEST = "file the thriveventory purchase order from this vendor invoice";

beforeAll(() => {
  // Assert the pins rather than trusting them — see the F16 note above.
  expect(process.env.LAX_DATA_DIR).toBe(TEMP_LAX);
  expect(getRuntimeConfig().workspace).toBe(TEMP_WORKSPACE);
});

beforeEach(() => {
  store.turns = [];
  store.messages = [];
  _resetSkillReviewQueue();
  coalescer.reset();
  resetSession(CHAT);
  resetSession(OTHER);
  saveCustomProtocols([]);
  mocks.runAgent.mockReset();
  mocks.resolveProvider.mockReset();
  mocks.resolveProvider.mockResolvedValue({ provider: "anthropic", apiKey: "k", model: "main-model" });
  mocks.runEndOfTurn.mockReset();
  // Default: the pass completes without doing anything. Tests that care about
  // its real side effect (resetting curate-nudge) opt into it explicitly.
  mocks.runEndOfTurn.mockResolvedValue("completed");
});

afterAll(() => {
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
  setRuntimeConfig(ORIGINAL_CFG);
  // Only the two dirs this file created, by absolute path, after re-checking
  // that they are in fact the temp dirs we made.
  if (TEMP_LAX.includes("lax-xseam-laxdir-")) rmSync(TEMP_LAX, { recursive: true, force: true });
  if (TEMP_WORKSPACE.includes("lax-xseam-ws-")) rmSync(TEMP_WORKSPACE, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) D3 — the two end-of-turn passes cannot starve each other
// ─────────────────────────────────────────────────────────────────────────────

describe("(a) the memory pass and the skill-review pass cannot starve each other", () => {
  it("one tool-heavy chat turn schedules BOTH passes", async () => {
    commitPurchaseOrderOp();
    expect(hasCurateSignal(CHAT)).toBe(false);

    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();

    // Skill half: queued, under the real chat session id.
    expect(peekSkillReviewQueue().map((r) => r.sessionId)).toEqual([CHAT]);

    // Memory half: the SAME trigger fired `long-task-completed`, which is the
    // gate the coalescer consults. Before chunk E wired it the slot had no
    // production caller at all, so a tool-heavy turn advanced nothing and the
    // memory pass ran only on a regex/classifier hit in the user's own text.
    expect(hasCurateSignal(CHAT)).toBe(true);
    requestEndOfTurnExtraction(eotCtx());
    await drainPendingExtractions();
    expect(mocks.runEndOfTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps the two queues in separate per-session state (D3)", async () => {
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();
    requestEndOfTurnExtraction(eotCtx());
    await drainPendingExtractions();

    // Same session key, two independent stores. A single shared pending slot —
    // the design D3 rejected — would mean one entry, and whichever pass wrote
    // last would have erased the other's work.
    expect(peekSkillReviewQueue()).toHaveLength(1);
    expect(coalescer.states.has(CHAT)).toBe(true);
    expect(coalescer.states.get(CHAT)).not.toBe(peekSkillReviewQueue()[0]);
    // And the containers themselves are distinct objects, not one map aliased
    // under two names.
    expect(coalescer.states as unknown).not.toBe(nudge.sessions as unknown);
  });

  it("draining the skill-review queue does not consume the memory pass's curate signal", async () => {
    // The one mutable thing the two seams share is curate-nudge's per-session
    // state, and the coupling is one-way by design: the skill TRIGGER writes it
    // (boostNudgePriority) and the MEMORY pass consumes it. If the review pass
    // ever also consumed or reset it, every tool-heavy turn would open the
    // memory gate and the review would slam it shut before the memory pass ran
    // — starvation, silent, and only visible from here.
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();
    expect(hasCurateSignal(CHAT)).toBe(true);

    forkCalls(PO_CREATE);
    registerSkillReviewRunner(fakeDeps());
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });

    expect(hasCurateSignal(CHAT)).toBe(true);
    requestEndOfTurnExtraction(eotCtx());
    await drainPendingExtractions();
    expect(mocks.runEndOfTurn).toHaveBeenCalledTimes(1);
  });

  it("the memory pass consuming its signal does not drop a queued skill review", async () => {
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();
    const queuedTranscript = peekSkillReviewQueue()[0].transcript;

    // Model the memory pass's only observable side effect on shared state:
    // end-of-turn-write.ts resets curate-nudge when it runs.
    mocks.runEndOfTurn.mockImplementation(async (ctx: EndOfTurnContext) => {
      resetSession(ctx.sessionId);
      return "completed";
    });
    requestEndOfTurnExtraction(eotCtx());
    await drainPendingExtractions();
    expect(hasCurateSignal(CHAT)).toBe(false);

    // The review is still there, unchanged, and still runnable.
    expect(peekSkillReviewQueue()).toHaveLength(1);
    expect(peekSkillReviewQueue()[0].transcript).toBe(queuedTranscript);
    forkCalls(PO_CREATE);
    registerSkillReviewRunner(fakeDeps());
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });
  });

  it("a skill review that never returns does not delay the memory pass", async () => {
    // The review runs the MAIN model on the background lane, where canonical's
    // own wall clock is inert (worker.ts arms it only for the interactive
    // lane), so a review can legitimately sit in flight for minutes. If the
    // memory pass shared any part of that critical section, every tool-heavy
    // turn would postpone memory curation by the length of a model call.
    // One real turn schedules both, for the SAME session — the contended case.
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();

    const hung = deferred<{ messages: unknown[] }>();
    mocks.runAgent.mockImplementation(() => hung.promise);
    registerSkillReviewRunner(fakeDeps());
    const review = runSkillReviewPass();
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));

    requestEndOfTurnExtraction(eotCtx());
    await drainPendingExtractions();
    expect(mocks.runEndOfTurn).toHaveBeenCalledTimes(1);

    hung.resolve({ messages: [] });
    await expect(review).resolves.toMatchObject({ reviewed: 1 });
  });

  it("a memory extraction that never returns does not delay the skill review", async () => {
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();

    const hung = deferred<"completed">();
    mocks.runEndOfTurn.mockImplementation(() => hung.promise);
    requestEndOfTurnExtraction(eotCtx());
    await vi.waitFor(() => expect(mocks.runEndOfTurn).toHaveBeenCalledTimes(1));
    // Still in flight — and holding the coalescer's single per-session slot.
    expect(coalescer.states.get(CHAT)?.inProgress).toBe(true);

    forkCalls(PO_CREATE);
    registerSkillReviewRunner(fakeDeps());
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });
    expect(loadCustomProtocols().map((p) => p.name)).toEqual(["thriveventory_purchase_order"]);

    hung.resolve("completed");
    await drainPendingExtractions();
  });

  it("the fork cannot trip the coalescer's mutual-exclusion skip", async () => {
    // The coalescer SKIPS an extraction outright when a "tool"-source memory
    // write landed since its cursor — "the main agent already curated memory,
    // don't fight it". The fork is an agent writing on the same session's
    // behalf, so if its allowlist carried any memory-writing tool, a review
    // would look exactly like that and silently cancel the memory pass. It
    // cannot: the allowlist is `protocol` and nothing else.
    const registry = ["remember", "memory_save", "memory_update_profile", "memory_set_user_field",
      "memory_consolidate", "memory_search", "write", "edit", "bash"].map(stubTool);
    expect(buildReviewTools([...registry, writingProtocolBase], CHAT).map((t) => t.name)).toEqual(["protocol"]);

    const tickBefore = getLastWriteTick("tool");
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();
    forkCalls(PO_CREATE);
    registerSkillReviewRunner(fakeDeps());
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });

    // A whole review, including a protocol write, moved the memory write clock
    // by nothing at all.
    expect(getLastWriteTick("tool")).toBe(tickBefore);
    requestEndOfTurnExtraction(eotCtx());
    await drainPendingExtractions();
    expect(mocks.runEndOfTurn).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) the write→read loop closes
// ─────────────────────────────────────────────────────────────────────────────

describe("(b) a protocol the fork authors is surfaced on a later matching request", () => {
  it("closes the loop end to end: trigger → queue → fork → authorProtocol → suggestion", async () => {
    // Before: the shipped catalog has nothing for this request. Asserting this
    // first is what makes the assertion after the review attributable to the
    // write — without it the test would pass on a coincidental built-in match.
    expect(getLearnedProtocolSuggestion(PO_REQUEST)).toBeNull();

    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(1);

    forkCalls(PO_CREATE);
    registerSkillReviewRunner(fakeDeps());
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });

    // Write half landed, in the only tier that can carry provenance (F14).
    const [saved] = loadCustomProtocols();
    expect(saved.name).toBe("thriveventory_purchase_order");
    expect(saved.source?.type).toBe("custom");
    expect(saved.source?.authoredBy).toBe("agent");
    expect(saved.source?.authoredFromSession).toBe(CHAT);

    // Read half: the same request now resolves to it, unprompted.
    const suggestion = getLearnedProtocolSuggestion(PO_REQUEST);
    expect(suggestion?.name).toBe("thriveventory_purchase_order");
    expect(suggestion?.nudge).toContain('protocol(action:"get"');
    expect(suggestion?.nudge).toContain("thriveventory_purchase_order");
  });

  it("closes the loop for the PATCH path too, which the prompt prefers over create", async () => {
    // "Patch the protocol that was actually used" is step 1 of the fork's
    // instructions, so an in-place edit that retrieval cannot see would make
    // the preferred path the dead one. (F1: nothing invalidated the search
    // index on an in-place edit, and the count backstop cannot notice an edit.)
    createProtocol({
      name: "po_intake", description: "Placeholder", triggers: [],
      steps: [], rules: [], learnablePreferences: [],
      source: { type: "custom", authoredBy: "agent", authoredAt: 1000, authoredFromSession: CHAT },
    });
    expect(getLearnedProtocolSuggestion(PO_REQUEST)).toBeNull();

    forkCalls({
      action: "edit",
      params: {
        name: "po_intake",
        updates: {
          description: "Create a purchase order in Thriveventory from a supplier invoice",
          triggers: ["thriveventory purchase order", "thrive po from invoice"],
        },
      },
    });
    registerSkillReviewRunner(fakeDeps());
    requestSkillReview({ sessionId: CHAT, toolSequence: PO_TOOLS, transcript: "t" });
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });

    expect(getLearnedProtocolSuggestion(PO_REQUEST)?.name).toBe("po_intake");
    // The patch left its trace without rewriting who authored the record.
    const [patched] = loadCustomProtocols();
    expect(patched.source?.authoredBy).toBe("agent");
    expect(patched.source?.lastEditedBy).toBe("agent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) provenance survives the whole path
// ─────────────────────────────────────────────────────────────────────────────

describe("(c) agent provenance survives author → surface → archive → unarchive", () => {
  it("stays 'agent' across every hop, and the archive really does silence retrieval", async () => {
    forkCalls(PO_CREATE);
    registerSkillReviewRunner(fakeDeps());
    requestSkillReview({ sessionId: CHAT, toolSequence: PO_TOOLS, transcript: "t" });
    await expect(runSkillReviewPass()).resolves.toMatchObject({ reviewed: 1, failed: 0 });
    const NAME = "thriveventory_purchase_order";

    // 1. Authored + persisted.
    expect(loadCustomProtocols().find((p) => p.name === NAME)?.source?.authoredBy).toBe("agent");
    // 2. Loaded through the real read path (stampCustomSource must not clobber
    //    an existing source; mergeByName must not rebuild the record).
    expect(getAllProtocols().find((p) => p.name === NAME)?.source?.authoredBy).toBe("agent");
    // 3. Surfaced.
    expect(getLearnedProtocolSuggestion(PO_REQUEST)?.name).toBe(NAME);

    // 4. Archived — this is the user's undo for autonomous authoring, so it has
    //    to actually stop the protocol being pushed at the model. Nothing else
    //    tests the archive↔retrieval seam.
    expect(archiveProtocol(NAME, "user rejected the agent's work")!.protocol.source?.authoredBy).toBe("agent");
    expect(getAllProtocols().find((p) => p.name === NAME)).toBeUndefined();
    expect(getLearnedProtocolSuggestion(PO_REQUEST)).toBeNull();

    // 5. Unarchived — recoverable, still legible as agent work, and suggestible
    //    again. If provenance were rebuilt anywhere on this path the user would
    //    lose the ability to tell agent work from their own after one restore.
    const restored = unarchiveProtocol(NAME);
    expect(restored.error).toBeUndefined();
    expect(restored.restored?.source?.authoredBy).toBe("agent");
    expect(restored.restored?.source?.authoredFromSession).toBe(CHAT);
    expect(getAllProtocols().find((p) => p.name === NAME)?.source?.authoredBy).toBe("agent");
    expect(getLearnedProtocolSuggestion(PO_REQUEST)?.name).toBe(NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) the trigger's guards hold at the seam
// ─────────────────────────────────────────────────────────────────────────────

describe("(d) the trigger schedules both passes, or neither", () => {
  it("a tool-heavy user chat turn queues exactly one review under the real session id", async () => {
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();

    const queued = peekSkillReviewQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].sessionId).toBe(CHAT);
    expect([...queued[0].toolSequence]).toEqual(PO_TOOLS);
    expect(queued[0].transcript).toContain("external-create-po");
    expect(hasCurateSignal(CHAT)).toBe(true);
  });

  it("an uncommitted / cancelled terminal turn schedules NEITHER pass", async () => {
    // A user who pressed Stop has consented to nothing being learned from that
    // op — not a protocol, and not a memory curation pass either. The committed
    // prefix here is already review-worthy, so only the durability guard can
    // refuse, and the guard sits AHEAD of the nudge boost.
    stagePurchaseOrderUncommitted();
    requestSkillReviewForOp(chatOp(), CHAT, TERMINAL_TURN);
    await flushTrigger();

    expect(peekSkillReviewQueue()).toHaveLength(0);
    expect(hasCurateSignal(CHAT)).toBe(false);
    requestEndOfTurnExtraction(eotCtx());
    await drainPendingExtractions();
    expect(mocks.runEndOfTurn).not.toHaveBeenCalled();
  });

  it.each(["research", "build_app", "self_edit", "cron_run", "agent_spawn"])(
    "a delegated/background op of type %s schedules NEITHER pass",
    async (type) => {
      // Delegated ops inherit the PARENT chat session id, and BOTH seams key on
      // session — so an unfiltered trigger would overwrite the user's queued
      // review with a machine transcript AND open the memory gate on the user's
      // conversation off the back of a cron tick.
      commitPurchaseOrderOp();
      requestSkillReviewForOp(chatOp({ type, lane: "background" }), CHAT, TERMINAL_TURN);
      await flushTrigger();

      expect(peekSkillReviewQueue()).toHaveLength(0);
      expect(hasCurateSignal(CHAT)).toBe(false);
    },
  );

  it("a spawned op that named itself chat_turn schedules NEITHER pass", async () => {
    commitPurchaseOrderOp();
    requestSkillReviewForOp(chatOp({ parentOpId: "op-parent" }), CHAT, TERMINAL_TURN);
    await flushTrigger();
    expect(peekSkillReviewQueue()).toHaveLength(0);
    expect(hasCurateSignal(CHAT)).toBe(false);
  });
});
