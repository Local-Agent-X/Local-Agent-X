import { describe, it, expect, vi } from "vitest";
import {
  buildTurnContextCached,
  invalidateTurnContextCache,
} from "../src/agent-request/turn-context-cache.js";
import { persistTurnState } from "../src/routes/chat/run-chat-turn/canonical-run.js";

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
