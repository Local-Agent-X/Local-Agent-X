import { describe, it, expect, vi } from "vitest";
import {
  buildTurnContextCached,
  invalidateTurnContextCache,
} from "../src/agent-request/turn-context-cache.js";
import { persistTurnState } from "../src/routes/chat/run-chat-turn/canonical-run.js";
import { buildCleanHistory } from "../src/providers/sanitize.js";

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

// Race fix: when the user hits stop and immediately resumes, the resume turn's
// `prepared` snapshots history BEFORE the lock awaits the prior turn's salvage.
// The orchestrator rebuilds prepared.cleanHistory via buildCleanHistory from the
// now-current session.messages after an aborted-non-committing acquire — so the
// salvaged work must survive that rebuild into the resume's history window.
describe("buildCleanHistory — resume turn re-reads salvaged work", () => {
  it("keeps the most recent salvaged messages incl. the interrupted marker", () => {
    const history: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 50; i++) {
      history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `old-${i}` });
    }
    history.push({ role: "user", content: "clone the repo and ingest it" });
    history.push({
      role: "assistant",
      content: "[Previous turn was interrupted before it finished. The work above ran; continue from there.]",
    });

    const clean = buildCleanHistory(history as never, "web");
    const texts = clean.map((m) => String((m as { content: unknown }).content));

    // The aborted request + interrupted boundary survive into the resume turn.
    expect(texts.some((t) => t === "clone the repo and ingest it")).toBe(true);
    expect(texts.some((t) => /interrupted/i.test(t))).toBe(true);
    // Truncated (older "old-*" turns dropped), but the recent salvaged work kept.
    expect(clean.length).toBeLessThan(history.length);
  });
});
