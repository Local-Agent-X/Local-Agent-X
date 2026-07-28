/**
 * Tests for auto-search-context.ts — the extracted per-turn recall injector
 * plus the task-start cross-session addition.
 *
 * Contract under test:
 * - extraction is behavior-preserving: non-task-start turns produce the exact
 *   legacy same-session-only block (header, guidance, top-3 cap) and never
 *   issue a crossSession query;
 * - task-start turns merge the shared cross-session query's candidates
 *   through the same MMR rerank (cap 5 when cross contributes), rendered
 *   with the same caveat furniture plus a PAST SESSION origin tag;
 * - cross-session timeout/error degrades to same-session-only, never throws;
 * - LAX_TASK_START_RECALL=off disables only the cross-session addition;
 * - telemetry records crossSessionCandidates/crossSessionInjected.
 *
 * The memory store is stubbed the way sibling tests do (search-helpers
 * stubMemory): a bare { search: vi.fn() } cast — autoSearchContext and the
 * shared searchPastSessions core only touch .search.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MemoryIndex } from "./index-core.js";
import type { MemorySearchResult } from "./types.js";
import { autoSearchContext } from "./auto-search-context.js";
import { searchPastSessions } from "./tools/search/search-past-sessions.js";
import { logMemoryRecall } from "./recall-telemetry.js";

vi.mock("./tools/search/app-matcher.js", () => ({ findMatchingApps: vi.fn(async () => []) }));
vi.mock("./recall-telemetry.js", () => ({ logMemoryRecall: vi.fn() }));

const QUERY = "bambu printer hardened nozzles carbon fiber";
const DAY_MS = 24 * 60 * 60 * 1000;

function result(over: Partial<MemorySearchResult> & { snippet: string }): MemorySearchResult {
  return {
    path: "memory/bank/entities/bambu.md",
    startLine: 1,
    endLine: 3,
    score: 0.8,
    source: "entity",
    ...over,
  };
}

function crossResult(over: Partial<MemorySearchResult> & { snippet: string }): MemorySearchResult {
  return result({
    path: "session-live/sess-old",
    source: "session",
    score: 0.7,
    updatedAt: Date.now() - 3 * DAY_MS,
    provenance: {
      source: "session",
      source_type: "agent-x-session",
      session_id: "sess-old-123",
      date: "2026-07-01",
      trust_status: "mixed",
      taint_status: "unknown",
      label: "Local session transcript",
    },
    ...over,
  });
}

type SearchFn = MemoryIndex["search"];

/** Stub store: same-session results by default; cross results when the
 *  options carry crossSession: true (the shared core's signature move). */
function stubMemory(
  sameSession: MemorySearchResult[],
  cross: MemorySearchResult[] | (() => Promise<MemorySearchResult[]>) = [],
): { memory: MemoryIndex; search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async (_query: string, opts?: Parameters<SearchFn>[1]) => {
    if (opts?.crossSession) {
      return typeof cross === "function" ? cross() : cross;
    }
    return sameSession;
  });
  return { memory: { search } as never, search };
}

const LEGACY_HEADER = "<<<RETRIEVED_MEMORY_CONTENT — same session + profile only>>>";
const TASK_START_HEADER = "<<<RETRIEVED_MEMORY_CONTENT — this session + profile + past-session leads>>>";

const countEntries = (out: string) => (out.match(/, relevance \d/g) ?? []).length;

beforeEach(() => {
  vi.mocked(logMemoryRecall).mockClear();
});

afterEach(() => {
  delete process.env.LAX_TASK_START_RECALL;
  vi.useRealTimers();
});

describe("autoSearchContext — extraction preserved (non-task-start)", () => {
  it("renders the legacy same-session-only block and never queries cross-session", async () => {
    const { memory, search } = stubMemory([
      result({ snippet: "The bambu printer uses hardened nozzles.", updatedAt: Date.now() - 3 * DAY_MS }),
    ]);

    const out = await autoSearchContext(memory, QUERY, { sessionId: "sess-now" });

    expect(out).toContain(LEGACY_HEADER);
    expect(out).toContain("--- RELEVANT MEMORIES ---");
    expect(out).toContain("To pull from past sessions, call `search_past_sessions`.");
    expect(out).toContain("3 days ago");
    expect(out).toContain("may be outdated");
    expect(out).not.toContain("PAST SESSION");
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(QUERY, { maxResults: 10, minScore: 0.35, sessionId: "sess-now" });
    expect(logMemoryRecall).not.toHaveBeenCalled();
  });

  it("caps at 3 snippets without cross-session contribution", async () => {
    const sameSession = Array.from({ length: 6 }, (_, i) =>
      result({ snippet: `distinct topic number ${i} — ${"abcdefgh"[i]} filament story`, score: 0.9 - i * 0.05 }),
    );
    const { memory } = stubMemory(sameSession);

    const out = await autoSearchContext(memory, QUERY, { sessionId: "sess-now" });

    expect(countEntries(out)).toBe(3);
  });

  it("still skips referential / short-answer / bare-number turns", async () => {
    const { memory, search } = stubMemory([result({ snippet: "x" })]);
    expect(await autoSearchContext(memory, "1", { taskStart: true })).toBe("");
    expect(await autoSearchContext(memory, "yes do that thing now", { taskStart: true })).toBe("");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("autoSearchContext — task-start cross-session recall", () => {
  it("merges cross-session leads with PAST SESSION furniture and session provenance", async () => {
    const { memory, search } = stubMemory(
      [result({ snippet: "Same-session note about the bambu printer nozzles." })],
      [crossResult({ snippet: "Prior session: we chose hardened steel nozzles for carbon fiber." })],
    );

    const out = await autoSearchContext(memory, QUERY, { sessionId: "sess-now", taskStart: true });

    expect(out).toContain(TASK_START_HEADER);
    expect(out).toContain("PAST SESSION — session");
    expect(out).toContain("session: sess-old-123");
    expect(out).toContain("3 days ago");
    expect(out).toContain("may be outdated");
    expect(out).toContain("relevance 0.70");
    expect(out).toContain("Same-session note about the bambu printer nozzles.");
    expect(out).toContain("leads, not proof");
    expect(out).toContain("call `search_past_sessions`");
    // The cross query went through the shared core (crossSession opt-in).
    expect(search).toHaveBeenCalledWith(QUERY, expect.objectContaining({
      crossSession: true,
      sources: ["session-summary", "session"],
      sessionId: "sess-now",
    }));
  });

  it("allows up to 5 total snippets when cross-session contributes", async () => {
    const sameSession = Array.from({ length: 6 }, (_, i) =>
      result({ snippet: `distinct topic number ${i} — ${"abcdefgh"[i]} filament story`, score: 0.9 - i * 0.05 }),
    );
    const cross = [
      crossResult({ snippet: "Prior session lead one about spool humidity control." }),
      crossResult({ snippet: "Prior session lead two about nozzle wear budgets.", path: "session-live/sess-old-2" }),
    ];
    const { memory } = stubMemory(sameSession, cross);

    const out = await autoSearchContext(memory, QUERY, { taskStart: true });

    expect(countEntries(out)).toBe(5);
  });

  it("emits the byte-identical legacy block when cross candidates exist but none survive MMR", async () => {
    const sameSession = Array.from({ length: 6 }, (_, i) =>
      result({ snippet: `distinct topic number ${i} — ${"abcdefgh"[i]} filament story`, score: 0.9 - i * 0.05 }),
    );
    // Token-identical to the top same-session pick (maximal MMR similarity
    // penalty) with negligible relevance — loses every argmax, so it is a
    // cross CANDIDATE that never becomes a cross INJECTION. Different
    // source/path keep it out of the same-session dedup, so this hits the
    // crossOnly.length > 0 && crossInjected === 0 truncation branch.
    const rejectedCross = crossResult({ snippet: sameSession[0].snippet, score: 0.01 });

    const taskStartRun = await autoSearchContext(
      stubMemory(sameSession, [rejectedCross]).memory, QUERY, { sessionId: "sess-now", taskStart: true },
    );
    const legacyRun = await autoSearchContext(
      stubMemory(sameSession).memory, QUERY, { sessionId: "sess-now" },
    );

    expect(taskStartRun).toContain(LEGACY_HEADER);
    expect(countEntries(taskStartRun)).toBe(3);
    expect(taskStartRun).toBe(legacyRun);
    expect(logMemoryRecall).toHaveBeenCalledWith(expect.objectContaining({
      phase: "auto-search", crossSessionCandidates: 1, crossSessionInjected: 0,
    }));
  });

  it("dedupes cross hits already found same-session and keeps the legacy shape when nothing cross-only survives", async () => {
    const shared = result({ snippet: "The bambu printer uses hardened nozzles." });
    const { memory } = stubMemory([shared], [result({ snippet: shared.snippet })]);

    const out = await autoSearchContext(memory, QUERY, { taskStart: true });

    expect(out).toContain(LEGACY_HEADER);
    expect(countEntries(out)).toBe(1);
    expect(out).not.toContain("PAST SESSION");
  });

  it("falls back to same-session-only when the cross query times out", async () => {
    vi.useFakeTimers();
    const { memory } = stubMemory(
      [result({ snippet: "Same-session note about the bambu printer nozzles." })],
      () => new Promise<MemorySearchResult[]>(() => { /* never resolves */ }),
    );

    const pending = autoSearchContext(memory, QUERY, { taskStart: true });
    await vi.advanceTimersByTimeAsync(3100);
    const out = await pending;

    expect(out).toContain(LEGACY_HEADER);
    expect(out).not.toContain("PAST SESSION");
  });

  it("falls back to same-session-only when the cross query rejects", async () => {
    const { memory } = stubMemory(
      [result({ snippet: "Same-session note about the bambu printer nozzles." })],
      () => Promise.reject(new Error("index locked")),
    );

    const out = await autoSearchContext(memory, QUERY, { taskStart: true });

    expect(out).toContain(LEGACY_HEADER);
    expect(out).not.toContain("PAST SESSION");
  });

  it("kill switch LAX_TASK_START_RECALL=off skips only the cross-session addition", async () => {
    process.env.LAX_TASK_START_RECALL = "off";
    const { memory, search } = stubMemory(
      [result({ snippet: "Same-session note about the bambu printer nozzles." })],
      [crossResult({ snippet: "Prior session lead that must not appear." })],
    );

    const out = await autoSearchContext(memory, QUERY, { taskStart: true });

    expect(out).toContain(LEGACY_HEADER);
    expect(out).not.toContain("must not appear");
    expect(search).toHaveBeenCalledTimes(1);
    expect(logMemoryRecall).not.toHaveBeenCalled();
  });

  it("records cross-session telemetry counts on task-start turns", async () => {
    const { memory } = stubMemory(
      [result({ snippet: "Same-session note about the bambu printer nozzles." })],
      [crossResult({ snippet: "Prior session: we chose hardened steel nozzles." })],
    );

    await autoSearchContext(memory, QUERY, { sessionId: "sess-now", taskStart: true });

    expect(logMemoryRecall).toHaveBeenCalledTimes(1);
    expect(logMemoryRecall).toHaveBeenCalledWith(expect.objectContaining({
      phase: "auto-search",
      sessionId: "sess-now",
      crossSessionCandidates: 1,
      crossSessionInjected: 1,
    }));
  });

  it("records zero-candidate task-start turns (measurability contract)", async () => {
    const { memory } = stubMemory([], []);

    const out = await autoSearchContext(memory, QUERY, { taskStart: true });

    expect(out).toBe("");
    expect(logMemoryRecall).toHaveBeenCalledWith(expect.objectContaining({
      phase: "auto-search",
      crossSessionCandidates: 0,
      crossSessionInjected: 0,
      bytesInjected: 0,
    }));
  });
});

describe("searchPastSessions shared core", () => {
  it("issues the canonical cross-session query the tool used to inline", async () => {
    const { memory, search } = stubMemory([], [crossResult({ snippet: "prior" })]);
    const since = new Date("2026-03-01");

    const results = await searchPastSessions(memory, "merchhelm", { maxResults: 7, since, sessionId: "sess-now" });

    expect(results).toHaveLength(1);
    expect(search).toHaveBeenCalledWith("merchhelm", {
      maxResults: 7,
      sources: ["session-summary", "session"],
      since,
      sessionId: "sess-now",
      crossSession: true,
    });
  });
});
