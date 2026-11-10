import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestNoteBy, notesSince, postNote, NOTE_TEXT_MAX, _resetHandoverNotesForTest, _setHandoverNotesForTest } from "./handover-notes.js";

let clock = 0;
const base = { displayName: "Fix STT", repoKey: "c:/r/.git", paths: ["src/voice/stt.ts"], kind: "agent" as const };

beforeEach(() => {
  clock = Date.parse("2026-11-09T12:00:00Z");
  _setHandoverNotesForTest({ dir: mkdtempSync(join(tmpdir(), "lax-notes-")), clock: () => clock });
});
afterEach(() => _resetHandoverNotesForTest());

describe("hand-over notes", () => {
  it("reads back in order, newer than a point, per repo", () => {
    const a = postNote({ ...base, sessionId: "agent-1", text: "swapped whisper base for trim" });
    clock += 1000;
    postNote({ ...base, sessionId: "chat-a", text: "moved VAD threshold" });
    postNote({ ...base, repoKey: "other", sessionId: "chat-x", text: "elsewhere" });
    expect(notesSince(base.repoKey).map((n) => n.text)).toEqual(["swapped whisper base for trim", "moved VAD threshold"]);
    expect(notesSince(base.repoKey, a.at).map((n) => n.sessionId)).toEqual(["chat-a"]);
    expect(latestNoteBy(base.repoKey, "agent-1")?.text).toBe("swapped whisper base for trim");
  });

  it("keeps a note short and on one line", () => {
    const n = postNote({ ...base, sessionId: "a", text: "line one\nline two " + "x".repeat(NOTE_TEXT_MAX) });
    expect(n.text.length).toBe(NOTE_TEXT_MAX);
    expect(n.text).not.toContain("\n");
  });

  it("drops days older than two weeks", () => {
    const first = postNote({ ...base, sessionId: "a", text: "old" });
    clock += 15 * 86_400_000;
    postNote({ ...base, sessionId: "a", text: "new" });
    expect(notesSince(base.repoKey).map((n) => n.text)).toEqual(["new"]);
    expect(existsSync(first.at.slice(0, 10))).toBe(false);
  });
});
