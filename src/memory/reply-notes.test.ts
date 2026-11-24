// A note that lands on a reply after it ended (the figures check) is saved
// beside the chat and joined onto that reply when the chat loads. Before, it
// reached the open tab only and vanished on reload (2026-11-24).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachReplyNotes, deleteReplyNotes, readReplyNotes, upsertReplyNote, type ReplyNote } from "./reply-notes.js";
import { withReplyNotes } from "./session-message-log.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-reply-notes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const note = (over: Partial<ReplyNote> = {}): ReplyNote => ({
  id: "figures-1", kind: "figures", at: 2_000, status: "checking", text: "Checking the figures in report.html against their sources…", updatedAt: 2_000, ...over,
});

describe("saving a reply's notes", () => {
  it("keeps one note per check: a later state replaces the earlier", () => {
    upsertReplyNote(dir, "chat-1", note());
    upsertReplyNote(dir, "chat-1", note({ status: "corrected", text: "Corrected 2 figures in report.html after this answer to match their sources." }));
    expect(readReplyNotes(dir, "chat-1")).toEqual([expect.objectContaining({ id: "figures-1", status: "corrected" })]);
  });

  it("an unreadable file loads as no notes, and deleting the chat deletes them", () => {
    expect(readReplyNotes(dir, "missing")).toEqual([]);
    upsertReplyNote(dir, "chat-1", note());
    deleteReplyNotes(dir, "chat-1");
    expect(existsSync(join(dir, "chat-1.notes.json"))).toBe(false);
  });
});

describe("joining notes onto replies", () => {
  const messages = [
    { role: "user", content: "build the report" },
    { role: "assistant", content: "Here it is.", _at: 1_000 },
    { role: "user", content: "thanks" },
    { role: "assistant", content: "Anytime.", _at: 3_000 },
  ];

  it("a note joins the last reply at or before it, not a later one", () => {
    const out = attachReplyNotes(messages, [note({ at: 2_000 })]);
    expect((out[1] as { _notices?: unknown[] })._notices).toEqual([expect.objectContaining({ id: "figures-1" })]);
    expect((out[3] as { _notices?: unknown[] })._notices).toBeUndefined();
    expect((messages[1] as { _notices?: unknown[] })._notices).toBeUndefined(); // the input is not changed
  });

  it("with no reply times, it joins the last reply", () => {
    const out = attachReplyNotes([{ role: "user" }, { role: "assistant" }], [note()]);
    expect((out[1] as { _notices?: unknown[] })._notices).toHaveLength(1);
  });

  it("a loaded chat carries its saved notes on the right reply", () => {
    upsertReplyNote(dir, "chat-1", note({ at: 2_000, status: "confirmed", text: "Checked the figures against their sources: they match." }));
    const session = { id: "chat-1", messages, createdAt: 0, updatedAt: 0 } as never;
    const loaded = withReplyNotes(session, dir) as { messages: Array<{ _notices?: Array<{ status: string }> }> };
    expect(loaded.messages[1]._notices?.[0].status).toBe("confirmed");
  });
});
