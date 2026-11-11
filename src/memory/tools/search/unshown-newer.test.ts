import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../types.js";
import { saidAt, unshownNewer, unshownNewerNote } from "./unshown-newer.js";

function hit(sessionId: string, datetime: string, label = sessionId): MemorySearchResult {
  return {
    path: `session-live/${sessionId}`, startLine: 1, endLine: 2, score: 0.5, snippet: "…", source: "session",
    metadata: { datetime },
    provenance: { source: "session", source_type: "agent-x-session", session_id: sessionId, date: datetime.slice(0, 10), when: datetime, trust_status: "mixed", taint_status: "unknown", label },
  } as MemorySearchResult;
}

describe("what a past-chat search leaves below its cut", () => {
  // 2026-11-10: the five closest matches were the day before's practice chats;
  // the afternoon's chat about how the interview went matched too, lower down.
  const shown = [hit("practice-a", "2026-11-09T15:00:00"), hit("practice-b", "2026-11-09T18:30:00")];

  it("names a chat that matched, was cut, and is newer than everything shown", () => {
    const rest = [hit("older", "2026-11-03T09:00:00"), hit("drill", "2026-11-10T14:05:00", "Interview Drill time")];
    const found = unshownNewer(shown, rest);
    expect(found).toEqual({ unshown: 2, newerChats: [{ sessionId: "drill", label: "Interview Drill time", when: "2026-11-10T14:05:00" }] });
    const note = unshownNewerNote(found);
    expect(note).toContain('"Interview Drill time" 2026-11-10T14:05:00 session=drill');
    expect(note).toContain("NEWER than everything above");
    expect(note).toContain("before saying it is not there");
  });

  it("says nothing when what was cut is older, or is more of a chat already shown", () => {
    const rest = [hit("older", "2026-11-03T09:00:00"), hit("practice-b", "2026-11-09T19:00:00")];
    expect(unshownNewerNote(unshownNewer(shown, rest))).toBe("");
    expect(unshownNewerNote(unshownNewer(shown, []))).toBe("");
  });

  it("lists each newer chat once, newest first, and counts the ones it does not name", () => {
    const rest = [
      hit("a", "2026-11-10T08:00:00"), hit("b", "2026-11-10T09:00:00"), hit("b", "2026-11-10T09:30:00"),
      hit("c", "2026-11-10T10:00:00"), hit("d", "2026-11-10T11:00:00"),
    ];
    const found = unshownNewer(shown, rest);
    expect(found.newerChats.map((c) => c.sessionId)).toEqual(["d", "c", "b", "a"]);
    expect(found.newerChats[2]?.when).toBe("2026-11-10T09:30:00");
    const note = unshownNewerNote(found);
    expect(note).toContain("(and 1 more)");
    expect(note).not.toContain("session=a");
  });

  it("dates a hit by when it was said, then its chat's day, then when it was indexed", () => {
    expect(saidAt(hit("x", "2026-11-10T14:05:00"))).toBe(Date.parse("2026-11-10T14:05:00"));
    const dayOnly = { ...hit("x", "2026-11-10T14:05:00"), metadata: {} } as MemorySearchResult;
    expect(saidAt(dayOnly)).toBe(Date.parse("2026-11-10"));
    const bare = { path: "p", startLine: 1, endLine: 1, score: 1, snippet: "", source: "session", updatedAt: 42 } as MemorySearchResult;
    expect(saidAt(bare)).toBe(42);
  });
});
