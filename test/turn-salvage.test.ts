import { describe, it, expect, vi } from "vitest";
import {
  buildTurnContextCached,
  invalidateTurnContextCache,
} from "../src/agent-request/turn-context-cache.js";
import { persistTurnState } from "../src/routes/chat/run-chat-turn/canonical-run.js";
import { sanitizeHistory } from "../src/providers/sanitize.js";
import { applyCheckpoint } from "../src/context-manager/checkpoint-history.js";

// Committed-rows path for the checkpoint-text salvage test: a real op id makes
// persistTurnState read op_messages; these mocks give it committed rows WITHOUT
// assistant text (a tool-call-only run), the exact case where the streamed
// checkpoint text used to be dropped. Only tests passing a non-empty
// canonicalOpId reach these.
vi.mock("../src/canonical-loop/store.js", () => ({
  readOpMessages: vi.fn(() => [{ messageId: "msg-user-1" }]),
}));
vi.mock("../src/canonical-loop/chat-runner.js", () => ({
  opMessageRowToChatParam: vi.fn(() => ({ role: "user", content: "run the long browser task" })),
}));

// Fix C — turn salvage on stop.
//
// The bug (2026-06-27): hitting stop interrupted a turn before it committed;
// persistTurnState sat after the stream loop so the aborting throw skipped it,
// and the turn's work never reached session.messages. On "keep going" the agent
// had no record of what it just did and re-derived it. Two halves:
//   1. an interrupted turn still persists (and marks) its work
//   2. the stale turn-context cache is evicted so the resume rebuilds fresh

describe("persistTurnState — interrupted turn is salvaged, not erased", () => {
  it("persists the user turn AND a boundary marker when interrupted", async () => {
    const session = { messages: [] as unknown[], updatedAt: 0 } as never;
    const saveSession = vi.fn();
    const ctx = { saveSession } as never;

    await persistTurnState({
      canonicalOpId: "", // no committed op rows → exercises the never-drop fallback
      message: "clone the repo and ingest it",
      assistantText: "",
      session,
      ctx,
      sessionId: "sess-salvage-1",
      images: [],
      interrupted: true,
    });

    const msgs = (session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    // The user's request survives.
    expect(msgs.some((m) => m.role === "user" && m.content === "clone the repo and ingest it")).toBe(true);
    // A clear interrupted boundary is left so the resume turn continues coherently.
    expect(msgs.some((m) => m.role === "assistant" && /interrupted/i.test(m.content))).toBe(true);
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT add the interrupted marker on a clean turn", async () => {
    const session = { messages: [] as unknown[], updatedAt: 0 } as never;
    const ctx = { saveSession: vi.fn(), memoryManager: { persistTurn: vi.fn(async () => {}) } } as never;

    await persistTurnState({
      canonicalOpId: "",
      message: "what is 2+2",
      assistantText: "4",
      session,
      ctx,
      sessionId: "sess-salvage-2",
      images: [],
      interrupted: false,
    });

    const msgs = (session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(msgs.some((m) => /interrupted/i.test(String(m.content)))).toBe(false);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "4")).toBe(true);
  });

  it("persists checkpoint assistant text when there are no committed assistant rows", async () => {
    const session = { messages: [] as unknown[], updatedAt: 0 } as never;
    const ctx = { saveSession: vi.fn(), memoryManager: { persistTurn: vi.fn(async () => {}) } } as never;

    await persistTurnState({
      canonicalOpId: "",
      message: "run the long browser task",
      assistantText: "I reached the 25-iteration checkpoint. Say \"continue\" and I'll pick up from the work already done.",
      session,
      ctx,
      sessionId: "sess-salvage-checkpoint",
      images: [],
      interrupted: true,
    });

    const msgs = (session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(msgs.some((m) => m.role === "assistant" && /25-iteration checkpoint/i.test(m.content))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && /interrupted/i.test(m.content))).toBe(true);
  });

  it("persists checkpoint text when the op committed rows but none carry assistant text", async () => {
    // The real regression: canonicalOpId is set, op_messages has committed rows
    // (mocked above as a user row — a tool-call-only run), so the never-drop
    // fallback does NOT fire. Before the hasAssistantContent salvage, the
    // streamed checkpoint text was silently dropped here and the resume turn
    // lost the assistant's narration entirely.
    const session = { messages: [] as unknown[], updatedAt: 0 } as never;
    const ctx = { saveSession: vi.fn(), memoryManager: { persistTurn: vi.fn(async () => {}) } } as never;

    await persistTurnState({
      canonicalOpId: "op_committed_rows_no_assistant_text",
      message: "run the long browser task",
      assistantText: "I reached the 25-iteration checkpoint. Say \"continue\" and I'll pick up from the work already done.",
      session,
      ctx,
      sessionId: "sess-salvage-checkpoint-2",
      images: [],
      interrupted: true,
    });

    const msgs = (session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    // Committed row survived AND the checkpoint text was appended, not dropped.
    expect(msgs.some((m) => m.role === "user" && m.content === "run the long browser task")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && /25-iteration checkpoint/i.test(m.content))).toBe(true);
  });
});

describe("invalidateTurnContextCache — stale context evicted on interrupt", () => {
  it("forces a rebuild after invalidation (no stale pre-interruption HIT)", async () => {
    const built: TurnContextLike[] = [];
    const buildTurnContext = vi.fn(async () => {
      const ctx = { block: `built-${built.length}` } as unknown as TurnContextLike;
      built.push(ctx);
      return ctx;
    });
    const mm = { buildTurnContext } as never;
    const input = {
      sessionId: "sess-cache-1",
      userMessage: "hello there",
      sessionMessages: [{ role: "user", content: "hello there" }],
    } as never;

    await buildTurnContextCached(mm, input); // MISS → build #1
    await buildTurnContextCached(mm, input); // HIT  → no build
    expect(buildTurnContext).toHaveBeenCalledTimes(1);

    invalidateTurnContextCache("sess-cache-1");

    await buildTurnContextCached(mm, input); // MISS again → build #2
    expect(buildTurnContext).toHaveBeenCalledTimes(2);
  });
});

interface TurnContextLike {
  block: string;
}

// Race fix: when the user hits stop and immediately resumes, the resume turn's
// `prepared` snapshots history BEFORE the lock awaits the prior turn's salvage.
// The orchestrator rebuilds prepared.cleanHistory from the now-current
// session.messages after an aborted-non-committing acquire — sanitizeHistory
// plus the session's checkpoint, the same shape prepare-request used. The
// salvaged work must survive that rebuild.
//
// It used to be rebuilt through a 40-ROW window (deleted 2026-09-16), and this
// test asserted the truncation itself. What matters is not that history got
// shorter — it is that the aborted request and its interrupted marker are
// still there for the resume turn to read.
describe("resume turn re-reads salvaged work", () => {
  const salvaged = () => {
    const history: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 50; i++) {
      history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `old-${i}` });
    }
    history.push({ role: "user", content: "clone the repo and ingest it" });
    history.push({
      role: "assistant",
      content: "[Previous turn was interrupted before it finished. The work above ran; continue from there.]",
    });
    return history;
  };

  it("keeps the most recent salvaged messages incl. the interrupted marker", () => {
    const clean = sanitizeHistory(salvaged() as never);
    const texts = clean.map((m) => String((m as { content: unknown }).content));
    expect(texts.some((t) => t === "clone the repo and ingest it")).toBe(true);
    expect(texts.some((t) => /interrupted/i.test(t))).toBe(true);
  });

  it("survives a checkpoint that summarises the older turns", () => {
    const history = salvaged();
    // A checkpoint covering the 50 stale rows: the resume turn sends a summary
    // for those and the salvaged tail verbatim.
    const clean = applyCheckpoint(
      sanitizeHistory(history as never),
      { summary: "earlier: fifty turns of unrelated work", coversThrough: 50 },
    );
    const texts = clean.map((m) => String((m as { content: unknown }).content));
    expect(texts.some((t) => t === "clone the repo and ingest it")).toBe(true);
    expect(texts.some((t) => /interrupted/i.test(t))).toBe(true);
    expect(texts.some((t) => t.includes("old-0")), "the checkpointed head is summarised, not replayed").toBe(false);
    expect(clean.length).toBeLessThan(history.length);
  });
});
