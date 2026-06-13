import { describe, it, expect } from "vitest";
import { isSyntheticSessionId, SYNTHETIC_SESSION_PREFIXES } from "../src/memory/synthetic-sessions.js";

// Regression for the memory_dream self-ingestion blowup: dream globbed every
// *.jsonl in ~/.lax/sessions with NO prefix filter, so each run re-ingested
// prior dream-*.jsonl output (which already embedded earlier transcripts),
// compounding exponentially until a single session file reached 150 MB. The
// fix routes all three session readers (dream input, live index, UI list)
// through this one classifier so a generated session can never be treated as
// real history again.
describe("isSyntheticSessionId", () => {
  it("classifies every generated prefix as synthetic — raw id and .jsonl filename", () => {
    for (const p of SYNTHETIC_SESSION_PREFIXES) {
      expect(isSyntheticSessionId(`${p}1780687489740`)).toBe(true);
      expect(isSyntheticSessionId(`${p}1780687489740.jsonl`)).toBe(true);
    }
  });

  it("the exact file that blew up is excluded (dream's own output)", () => {
    expect(isSyntheticSessionId("dream-1780687489740.jsonl")).toBe(true);
  });

  it("treats real user conversations as NOT synthetic", () => {
    expect(isSyntheticSessionId("a1b2c3d4-session")).toBe(false);
    expect(isSyntheticSessionId("1780687489740.jsonl")).toBe(false);
    expect(isSyntheticSessionId("daydream-notes")).toBe(false); // substring, not prefix
    expect(isSyntheticSessionId("my-cron-job")).toBe(false);    // prefix must be leading
  });
});
