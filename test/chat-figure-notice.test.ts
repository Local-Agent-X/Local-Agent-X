// @vitest-environment happy-dom
//
// The figures check shows on the reply it checked, updated in place: a
// `reply_note` event joins the right reply (the last one at or before the
// note, the server's rule too, src/memory/reply-notes.ts) and replaces that
// check's earlier state; the row draws it with the other notices. It used to
// be a separate chat line, added by the open tab alone, that vanished on
// reload (2026-11-24).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, unknown>;
const load = <T>(file: string, ret: string): T =>
  // eslint-disable-next-line no-new-func
  new Function(`${readFileSync(join(here, "../public/js/" + file), "utf8")}; return ${ret};`)() as T;

type Msg = { role: string; content?: string; _at?: number; _notices?: Array<{ id: string; status: string }> };
type Note = { id: string; kind: "figures"; at: number; status: string; text: string };
let bg: { attachReplyNote: (m: Msg[], n: Note) => boolean; handleReplyNote: (msg: unknown) => boolean };
let renders: number;

beforeEach(() => {
  document.body.innerHTML = "";
  g.esc = (s: unknown) => String(s ?? "");
  renders = 0;
  g.renderMessages = () => { renders++; };
  bg = load("chat-ws-handler-bg-ops.js", "{ attachReplyNote, handleReplyNote }");
});

const note = (over: Partial<Note> = {}): Note => ({ id: "figures-1", kind: "figures", at: 2_000, status: "checking", text: "Checking the figures in report.html against their sources…", ...over });

describe("a reply_note on the open chat", () => {
  it("joins the reply it checked, and a later state replaces the earlier one", () => {
    const messages: Msg[] = [
      { role: "user" }, { role: "assistant", _at: 1_000 }, { role: "user" }, { role: "assistant", _at: 3_000 },
    ];
    g.activeChat = { id: "chat-1", messages };
    expect(bg.handleReplyNote({ sessionId: "chat-1", event: { type: "reply_note", note: note() } })).toBe(true);
    expect(bg.handleReplyNote({ sessionId: "chat-1", event: { type: "reply_note", note: note({ status: "corrected" }) } })).toBe(true);
    expect(messages[1]._notices).toEqual([expect.objectContaining({ id: "figures-1", status: "corrected" })]);
    expect(messages[3]._notices).toBeUndefined();
    expect(renders).toBe(2);
  });

  it("a check before 'done' rides the reply still streaming, not the saved one before it", () => {
    const messages: Msg[] = [{ role: "assistant", _at: 1_000 }];
    g.activeChat = { id: "chat-1", messages };
    const applied: unknown[] = [];
    let rerendered = "";
    g.ChatStreamStore = { isStreaming: (s: string) => s === "chat-1", applyEvent: (_s: string, e: unknown) => applied.push(e) };
    g.rerenderLiveMessage = (s: string) => { rerendered = s; };
    const event = { type: "reply_note", note: note({ on: "next" } as Partial<Note>) };
    bg.handleReplyNote({ sessionId: "chat-1", event });
    expect(applied).toEqual([event]);
    expect(rerendered).toBe("chat-1");
    expect(messages[0]._notices).toBeUndefined();
    delete g.ChatStreamStore;
  });

  it("another chat's note leaves the open chat alone", () => {
    const messages: Msg[] = [{ role: "assistant", _at: 1_000 }];
    g.activeChat = { id: "chat-1", messages };
    bg.handleReplyNote({ sessionId: "chat-2", event: { type: "reply_note", note: note() } });
    expect(messages[0]._notices).toBeUndefined();
    expect(renders).toBe(0);
  });
});

describe("drawing it on the reply", () => {
  it("shows the note's text, classed by its status, beside the reply's other notices", () => {
    Object.assign(g, load<object>("chat-render-notices.js", "{ renderFigureNotice, renderDeleteNotice, renderChangesNotice, renderReviewNotice, renderLearningNotice, renderHandoffNotice }"));
    Object.assign(g, load<object>("chat-progress.js", "{ isProgressTool, renderReplyClose }"));
    Object.assign(g, load<object>("chat-turn-flow.js", "{ isSegmentBreak, toolSegmentsOf, renderTurnNow, activitySummaryOf, turnTokenEstimate, placeTurnNow }"));
    const artifacts = load<{ _renderAssistantToolArtifacts: (b: HTMLElement, d: unknown) => void }>("chat-render-artifacts.js", "{ _renderAssistantToolArtifacts }");
    const body = document.createElement("div");
    artifacts._renderAssistantToolArtifacts(body, { toolEvents: [], notices: [note({ status: "corrected", text: "Corrected 2 figures in report.html after this answer to match their sources." })] });
    const el = body.querySelector(".figure-notice") as HTMLElement;
    expect(el.className).toBe("figure-notice figure-notice-corrected");
    expect(el.textContent).toBe("Corrected 2 figures in report.html after this answer to match their sources.");
  });
});
