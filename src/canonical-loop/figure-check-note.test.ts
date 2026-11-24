// The figures check is one note on the reply it checked, updated in place and
// saved with the chat (figure-check-note.ts), not a separate line posted
// minutes after the "final" answer that vanished on reload (2026-11-24).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lax = vi.hoisted(() => ({ dir: "" }));
vi.mock("../lax-data-dir.js", () => ({ getLaxDir: () => lax.dir }));

import { _resetFigureCheckNotesForTests, figureCheckStarted, figureCheckUpdate, setFigureCheckBroadcaster } from "./figure-check-note.js";
import { readReplyNotes } from "../memory/reply-notes.js";

let events: Array<{ sessionId: string; event: unknown }>;
beforeEach(() => {
  lax.dir = mkdtempSync(join(tmpdir(), "lax-figure-note-"));
  mkdirSync(join(lax.dir, "sessions")); // the session store makes it at boot
  _resetFigureCheckNotesForTests();
  events = [];
  setFigureCheckBroadcaster((sessionId, event) => events.push({ sessionId, event }));
});
afterEach(() => rmSync(lax.dir, { recursive: true, force: true }));

const saved = (sessionId: string) => readReplyNotes(join(lax.dir, "sessions"), sessionId);

describe("the figures check's note on a reply", () => {
  it("starts as checking, then becomes the result, as one saved note that is also sent live", () => {
    figureCheckStarted("chat-1", ["C:/work/app/report.html"]);
    expect(saved("chat-1")).toEqual([expect.objectContaining({ status: "checking", text: "Checking the figures in report.html against their sources…" })]);
    figureCheckUpdate("chat-1", "correcting", 2);
    figureCheckUpdate("chat-1", "corrected", 2);
    const notes = saved("chat-1");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual(expect.objectContaining({ status: "corrected", text: "Corrected 2 figures in report.html after this answer to match their sources." }));
    expect(events.map((e) => (e.event as { note: { status: string } }).note.status)).toEqual(["checking", "correcting", "corrected"]);
    expect(events.every((e) => e.sessionId === "chat-1" && (e.event as { type: string }).type === "reply_note")).toBe(true);
  });

  it.each([
    ["confirmed", 0, "Checked the figures in report.html against their sources: they match."],
    ["mismatch", 1, "1 figure in report.html doesn't match their sources and couldn't be corrected automatically. Ask me to go through them."],
    ["mismatch", 3, "3 figures in report.html don't match their sources and couldn't be corrected automatically. Ask me to go through them."],
    ["unchecked", 0, "Couldn't check the figures in report.html against their sources."],
  ] as const)("%s (%i) reads: %s", (status, n, text) => {
    figureCheckStarted("chat-2", ["/w/report.html"]);
    figureCheckUpdate("chat-2", status, n);
    expect(saved("chat-2")[0].text).toBe(text);
  });

  it("a result with no check on record (a restart in between) still lands, as a fresh note", () => {
    figureCheckUpdate("chat-3", "corrected", 1);
    expect(saved("chat-3")).toEqual([expect.objectContaining({ status: "corrected", text: "Corrected 1 figure after this answer to match their sources." })]);
  });

  it("the next check is a new note; the last one's result stays", () => {
    figureCheckStarted("chat-4", ["/w/a.html"]);
    figureCheckUpdate("chat-4", "confirmed");
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    try {
      figureCheckStarted("chat-4", ["/w/a.html"]);
    } finally {
      vi.useRealTimers();
    }
    expect(saved("chat-4").map((n) => n.status)).toEqual(["confirmed", "checking"]);
  });
});
