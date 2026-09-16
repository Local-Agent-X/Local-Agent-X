/**
 * CLASS INVARIANT: a harness row reaches the MODEL on later messages, and
 * reaches nobody else — ever.
 *
 * Nudges used to be dropped when a turn was saved. Two consequences, both
 * live: the model was corrected on one message and had no trace of that
 * correction on the next (so it repeated itself), and the user saw replies
 * answering a question that was not in their transcript (2026-09-15, three
 * replies to a cleanup demand nobody made).
 *
 * Keeping them is only safe if every consumer can tell harness speech from the
 * user's. The tag evaporates at five points if nobody defends it — an
 * ephemeral-prefix filter, two consecutive-user merges, re-seeding, and the
 * provider adapters — and seven consumers read these rows. This asserts both
 * halves: the tag survives the round trip, and each consumer honours it.
 */
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isHarnessRow, markHarnessRow, userAuthoredRows } from "./harness-rows.js";
import { opMessageRowToChatParam } from "./canonical-loop/public/message-convert.js";
import { sanitizeHistory, stripEphemeralMessages } from "./providers/sanitize.js";
import { projectSessionForUI } from "./memory/session-message-log.js";
import { retractLastTurn } from "./memory/retract-last-turn.js";
import type { Session } from "./types.js";

// The row shape comes from the converter itself — the canonical-loop
// internals are sealed behind public/ (interface-seal.test.ts).
type OpRow = Parameters<typeof opMessageRowToChatParam>[0];

const nudgeRow = (text: string): OpRow => ({
  messageId: "nudge-op-1-2-0-abc",
  opId: "op-1",
  turnIdx: 2,
  seqInTurn: 0,
  role: "user",
  content: { text, kind: "nudge" },
  createdAt: new Date().toISOString(),
});

const userRow = (text: string): OpRow => ({
  messageId: "um-op-1-0-0-def",
  opId: "op-1",
  turnIdx: 0,
  seqInTurn: 0,
  role: "user",
  content: { text },
  createdAt: new Date().toISOString(),
});

const NUDGE_TEXT = "[automatic check] 1 tool call returned a non-ok status.";

describe("a nudge survives the turn boundary, tagged", () => {
  it("is persisted instead of dropped", () => {
    const row = opMessageRowToChatParam(nudgeRow(NUDGE_TEXT));
    expect(row, "the nudge was dropped — the model loses the correction next message").not.toBeNull();
    expect(row!.content).toBe(NUDGE_TEXT);
    expect(isHarnessRow(row!)).toBe(true);
  });

  it("a real user message is NOT tagged", () => {
    const row = opMessageRowToChatParam(userRow("delete those emails"));
    expect(isHarnessRow(row!)).toBe(false);
  });

  it("the persist-time ephemeral filter keeps it", () => {
    const kept = stripEphemeralMessages([
      { role: "user", content: "hi" },
      markHarnessRow({ role: "user", content: NUDGE_TEXT }, "nudge"),
    ]);
    expect(kept).toHaveLength(2);
    expect(isHarnessRow(kept[1])).toBe(true);
  });

  it("is never fused into the user's own sentence by the consecutive-user merge", () => {
    const out = sanitizeHistory([
      markHarnessRow({ role: "user", content: NUDGE_TEXT }, "nudge"),
      { role: "user", content: "no, do it the other way" },
    ]);
    const merged = out.find((m) => typeof m.content === "string" && String(m.content).includes(NUDGE_TEXT) && String(m.content).includes("other way"));
    expect(merged, "harness text was merged into the user's message").toBeUndefined();
    expect(out.filter((m) => isHarnessRow(m))).toHaveLength(1);
  });
});

describe("no consumer mistakes it for something the user said", () => {
  const session = (): Session => ({
    id: "s1",
    title: "t",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      { role: "user", content: "clean up the logs" },
      { role: "assistant", content: "done" },
      markHarnessRow({ role: "user", content: NUDGE_TEXT }, "nudge"),
      { role: "assistant", content: "I did not remove anything." },
    ],
  } as unknown as Session);

  it("the chat never renders it", () => {
    const shown = projectSessionForUI(session()).messages;
    expect(shown.some((m) => String(m.content).includes(NUDGE_TEXT))).toBe(false);
    expect(shown.some((m) => String(m.content).includes("clean up the logs"))).toBe(true);
  });

  it("retract finds the USER's last turn, not the nudge", () => {
    const out = retractLastTurn(session().messages as ChatCompletionMessageParam[], { includeUser: true });
    // The user's real last turn is "clean up the logs". Without the tag the
    // scan stops at the nudge and retracts only the harness's own instruction,
    // leaving the turn the user asked to undo.
    expect(out.messages.some((m) => String(m.content).includes(NUDGE_TEXT))).toBe(false);
    expect(out.messages.some((m) => String(m.content).includes("clean up the logs"))).toBe(false);
    // All four rows from the user turn onward, the nudge included.
    expect(out.removed).toBe(4);
  });

  it("userAuthoredRows is the conversation a person would recognise", () => {
    expect(userAuthoredRows(session().messages as ChatCompletionMessageParam[])).toHaveLength(3);
  });
});
