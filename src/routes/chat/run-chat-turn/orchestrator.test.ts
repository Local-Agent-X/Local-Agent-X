/**
 * CT-2 regression: startChat must NOT run before the turn lock is acquired.
 *
 * The bug: installEventWiring's `ctx.chatWs.startChat(sessionId)` does an
 * unconditional `activeChats.set(sessionId, newChat)`. When it ran BEFORE
 * tryAcquireOrReplace, a turn the lock was about to REFUSE (because the live
 * turn A had already made a committing tool call) would first overwrite A's
 * active-chat entry, then — on the refusal path — emit a `done` that flipped
 * that entry to done=true. Result: the AGENTS badge (broadcastActiveChats
 * filters !done) dropped while A kept streaming, and Stop hit chat.done===true
 * and returned false before ever aborting A — A became un-stoppable.
 *
 * The fix reorders the orchestrator: acquire the lock FIRST, and only reach
 * installEventWiring/startChat once it's granted. A refused turn surfaces its
 * error+done over the live transport WITHOUT registering a chat, leaving the
 * running turn's entry (and its stoppability) untouched.
 *
 * This is a sibling test so the vi.mock specifiers match orchestrator.ts's own
 * import paths. turn-lock is intentionally NOT mocked — we seed the real
 * registry with a committing prior turn so the real refusal path executes.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ServerEvent } from "../../../types.js";

vi.mock("./slash-interceptors.js", () => ({
  handleApproveCommand: vi.fn(async () => ({ handled: false })),
  expandSlash: vi.fn(async (m: string) => m),
}));
vi.mock("./prepare-and-route.js", () => ({
  preparePerTurnRequest: vi.fn(async () => ({
    apiKey: "k", provider: "xai", model: "grok", tools: [], cleanHistory: [],
  })),
  emitContextStatus: vi.fn(async () => {}),
  filterToolsForSession: vi.fn((t: unknown) => t),
  applyDiscussPrefix: vi.fn(async (m: string) => m),
}));
vi.mock("../jarvis-redirect.js", () => ({ tryWorkerRedirect: vi.fn(async () => false) }));
vi.mock("../../../routing/index.js", () => ({
  routeMessage: vi.fn(async () => ({ destination: "agent" })),
}));
vi.mock("../../../session/project.js", () => ({ setSessionProject: vi.fn() }));
vi.mock("../../../approval-manager.js", () => ({
  getApprovalManager: () => ({ clearDeclines: vi.fn() }),
}));
vi.mock("../../../session/policy.js", () => ({ clearSessionAllowedTools: vi.fn() }));

// The two steps downstream of the lock. If the orchestrator regresses and
// calls startChat before the lock decision, installEventWiring fires on a turn
// the lock refuses — exactly the pre-fix bug this test guards. Declared via
// vi.hoisted so the (hoisted) vi.mock factories can close over them.
const { installEventWiring, runCanonicalChat } = vi.hoisted(() => ({
  installEventWiring: vi.fn(async () => ({
    wsChat: { abort: new AbortController(), onEvent: () => {} },
    threatEngine: {},
    wrappedOnEvent: () => {},
    primaryEventProxy: () => {},
    getFullResponseText: () => "",
  })),
  runCanonicalChat: vi.fn(async () => ({ doneEmitted: true })),
}));
vi.mock("./event-wiring.js", () => ({ installEventWiring }));
vi.mock("./canonical-run.js", () => ({ runCanonicalChat }));

import { runChatTurn } from "./orchestrator.js";
import { getTurnRegistry, releaseTurn, getActiveTurn } from "../../../session/turn-lock.js";

const SESSION = "sess-ct2-refusal";

afterEach(() => {
  releaseTurn(SESSION);
  vi.clearAllMocks();
});

function makeCtx(onEmit: (id: string, ev: ServerEvent) => void) {
  const session = { messages: [] as unknown[], projectId: undefined, title: "" };
  const ctx = {
    flushSession: vi.fn(async () => {}),
    getOrCreateSession: vi.fn(() => session),
    saveSession: vi.fn(async () => {}),
    setActiveOnEvent: vi.fn(),
    setActiveRuntime: vi.fn(),
    setActiveBrowserSessionId: vi.fn(),
    dataDir: "/tmp",
    chatWs: {
      startChat: vi.fn(),
      emit: vi.fn((id: string, ev: ServerEvent) => onEmit(id, ev)),
      failChat: vi.fn(),
    },
  };
  return { ctx, session };
}

describe("orchestrator turn-lock ordering (CT-2)", () => {
  it("refuses without registering the chat when a committing turn is live", async () => {
    // Seed a live, committing prior turn A that holds the lock.
    const priorAbort = new AbortController();
    expect(getTurnRegistry().acquireTurn(SESSION, priorAbort, "prior")).toBe(true);
    getTurnRegistry().markIteration(SESSION, ["bash"]); // committing → refusal
    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);

    const emitted: Array<{ id: string; ev: ServerEvent }> = [];
    const { ctx } = makeCtx((id, ev) => emitted.push({ id, ev }));

    await runChatTurn({
      sessionId: SESSION,
      message: "second message while A is still running",
      attachments: [],
      projectId: null,
      ctx: ctx as never,
      requestRole: "operator",
      sseSink: null, // WS transport → refusal must reach the client via chatWs.emit
    });

    // Core invariant: the lock is consulted BEFORE startChat, so a refused turn
    // never reaches installEventWiring/startChat (which is what used to overwrite
    // and "done"-shadow A's active-chat entry).
    expect(installEventWiring).not.toHaveBeenCalled();
    expect(runCanonicalChat).not.toHaveBeenCalled();

    // Turn A is untouched: still committing-locked and NOT aborted by the refused
    // turn, so a subsequent Stop can still terminate it.
    expect(priorAbort.signal.aborted).toBe(false);
    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);

    // The refusal still reaches the WS client as error + terminal done.
    const forSession = emitted.filter(e => e.id === SESSION).map(e => e.ev.type);
    expect(forSession).toContain("error");
    expect(forSession).toContain("done");
    const err = emitted.find(e => e.ev.type === "error") as { ev: { message?: string } } | undefined;
    expect(String(err?.ev.message)).toMatch(/still running/i);
  });
});
