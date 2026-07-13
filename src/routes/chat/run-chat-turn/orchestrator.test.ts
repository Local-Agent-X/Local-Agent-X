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
  installEventWiring: vi.fn(async (_input: { onChatRegistered: (token: AbortController) => void }) => ({
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
import { preparePerTurnRequest } from "./prepare-and-route.js";
import { getTurnRegistry, releaseTurn, getActiveTurn } from "../../../session/turn-lock.js";

const SESSION = "sess-ct2-refusal";
const SESSION_ORPHAN = "sess-orphan-activechat";
const SESSION_EARLY = "sess-early-exit-no-key";

afterEach(() => {
  releaseTurn(SESSION);
  releaseTurn(SESSION_ORPHAN);
  releaseTurn(SESSION_EARLY);
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
      failChatIfCurrent: vi.fn((_sid: string, _token: AbortController, _msg: string) => true),
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

/**
 * Orphaned-ActiveChat regression (2026-07-13 audit skeptic finding).
 *
 * The bug: installEventWiring throws AFTER its internal startChat (e.g.
 * augmentSystemPrompt). The orchestrator catch runs emitTurnError, which sets
 * doneEmitted=true and pushes error+done via broadcast ONLY — never through
 * the registered entry's onEvent — so the entry's done flag stays false. The
 * finally's !doneEmitted failChat net is then skipped, leaving a permanently
 * live orphan ActiveChat: stale replay buffer for every future subscriber,
 * startChat overwrite warnings, heartbeat interval spinning forever.
 *
 * The fix: installEventWiring reports startChat via onChatRegistered(token)
 * (fired BEFORE the throwable wiring steps; token = the entry's own
 * AbortController), and the finally terminates any turn that registered a
 * chat via failChatIfCurrent(sessionId, token, "") — a no-op for entries
 * already done or owned by a successor turn (skeptic round 2: a wedged
 * turn's late error path must never mark a successor's live entry done),
 * and never called for turns that exited before startChat.
 */
describe("orchestrator orphaned-ActiveChat net", () => {
  it("fails the registered chat — identity-guarded with its token — when wiring throws after startChat", async () => {
    const token = new AbortController();
    installEventWiring.mockImplementationOnce(async (input) => {
      input.onChatRegistered(token); // startChat happened...
      throw new Error("augmentSystemPrompt exploded"); // ...then wiring died
    });

    const emitted: Array<{ id: string; ev: ServerEvent }> = [];
    const { ctx } = makeCtx((id, ev) => emitted.push({ id, ev }));

    await runChatTurn({
      sessionId: SESSION_ORPHAN,
      message: "hello",
      attachments: [],
      projectId: null,
      ctx: ctx as never,
      requestRole: "operator",
      sseSink: null,
    });

    // The registered entry must be terminated (buffered terminal done via
    // terminateChat) with NO extra error bubble — emitTurnError already sent
    // it — and WITH the registered token, so only this turn's own entry can
    // ever be terminated (never a successor's after a wedge-clobber).
    expect(ctx.chatWs.failChatIfCurrent).toHaveBeenCalledTimes(1);
    expect(ctx.chatWs.failChatIfCurrent).toHaveBeenCalledWith(SESSION_ORPHAN, token, "");
    expect(ctx.chatWs.failChat).not.toHaveBeenCalled();
    expect(runCanonicalChat).not.toHaveBeenCalled();

    // emitTurnError still surfaced the failure on the WS broadcast path.
    const types = emitted.filter(e => e.id === SESSION_ORPHAN).map(e => e.ev.type);
    expect(types).toContain("error");
    expect(types).toContain("done");

    // And the turn lock (acquired before wiring) was released by the finally.
    expect(getActiveTurn(SESSION_ORPHAN)).toBeFalsy();
  });

  it("does NOT call failChat for early exits before startChat", async () => {
    // Missing credential → emitTurnError + return, long before startChat. A
    // failChat here could touch a live entry owned by a DIFFERENT running turn.
    vi.mocked(preparePerTurnRequest).mockResolvedValueOnce({
      apiKey: "", provider: "xai", model: "grok", tools: [], cleanHistory: [],
    } as never);

    const emitted: Array<{ id: string; ev: ServerEvent }> = [];
    const { ctx } = makeCtx((id, ev) => emitted.push({ id, ev }));

    await runChatTurn({
      sessionId: SESSION_EARLY,
      message: "hello",
      attachments: [],
      projectId: null,
      ctx: ctx as never,
      requestRole: "operator",
      sseSink: null,
    });

    expect(installEventWiring).not.toHaveBeenCalled();
    expect(ctx.chatWs.failChat).not.toHaveBeenCalled();
    expect(ctx.chatWs.failChatIfCurrent).not.toHaveBeenCalled();
    const types = emitted.filter(e => e.id === SESSION_EARLY).map(e => e.ev.type);
    expect(types).toContain("error");
    expect(types).toContain("done");
  });

  it("happy path: no failure-message failChat; only the token-guarded empty-message net", async () => {
    const token = new AbortController();
    installEventWiring.mockImplementationOnce(async (input) => {
      input.onChatRegistered(token);
      return {
        wsChat: { abort: token, onEvent: () => {} },
        threatEngine: {},
        wrappedOnEvent: () => {},
        primaryEventProxy: () => {},
        getFullResponseText: () => "",
      };
    });
    // runCanonicalChat default mock: { doneEmitted: true } — entry already
    // done via wrappedOnEvent in the real flow, so the net's
    // failChatIfCurrent("") is a no-op (bails on done entries).

    const { ctx } = makeCtx(() => {});
    await runChatTurn({
      sessionId: SESSION_ORPHAN,
      message: "hello",
      attachments: [],
      projectId: null,
      ctx: ctx as never,
      requestRole: "operator",
      sseSink: null,
    });

    expect(runCanonicalChat).toHaveBeenCalledTimes(1);
    // The !doneEmitted crash net (with its user-facing message) must not fire.
    expect(ctx.chatWs.failChat).not.toHaveBeenCalled();
    // The done-path net only ever fires token-guarded with no error bubble.
    for (const call of ctx.chatWs.failChatIfCurrent.mock.calls) {
      expect(call[1]).toBe(token);
      expect(call[2]).toBe("");
    }
  });
});
