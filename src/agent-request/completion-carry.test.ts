import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { completionRow, withCompletionsCarried } from "./completion-carry.js";
import { harnessRowKind, isHarnessRow, markHarnessRow, userAuthoredRows } from "../harness-rows.js";
import type { PendingNotification } from "../ops/pending-notifications.js";

const sent: PendingNotification = {
  opId: "op_send_email_da72d16c",
  status: "completed",
  summary: "Sent the email to jenny@example.com with subject \"Love you\". Gmail returned message id 18f3.",
  filesChanged: [],
  task: "Email Jenny: tell her I love her and I'll see her later",
  completedAt: Date.UTC(2026, 10, 6, 18, 4),
};

const turn = (): ChatCompletionMessageParam[] => [
  { role: "user", content: "remind me when the show drops" },
  { role: "assistant", content: "Your reminder's set." },
];

describe("a finished background task stays in the chat", () => {
  it("records what finished and how, as a hidden harness row, never as the user's words", () => {
    const row = completionRow([sent])!;
    expect(isHarnessRow(row)).toBe(true);
    expect(harnessRowKind(row)).toBe("completion");
    const text = String(row.content);
    expect(text).toContain("Completed");
    expect(text).toContain("Email Jenny");
    expect(text).toContain("Sent the email");
    // The record is what keeps a later turn from sending it a second time.
    expect(text).toMatch(/never redo, resend or re-submit/);
    expect(userAuthoredRows([row])).toEqual([]);
  });

  it("is saved inside the turn that read it, after the user's message and its recall row", () => {
    const recall = markHarnessRow({ role: "user", content: "Recalled memory…" } as ChatCompletionMessageParam, "recall");
    const rows = [turn()[0], recall, turn()[1]];
    const saved = withCompletionsCarried(rows, [sent]);
    expect(saved.map((m) => harnessRowKind(m) ?? m.role)).toEqual(["user", "recall", "completion", "assistant"]);
  });

  it("says how each one ended, a failure included", () => {
    const failed = { ...sent, opId: "op_2", status: "failed" as const, summary: "SMTP refused the login." };
    const text = String(completionRow([sent, failed])!.content);
    expect(text).toContain("- Completed: \"Email Jenny");
    expect(text).toContain("- Failed: \"Email Jenny");
    expect(text).toContain("SMTP refused the login.");
  });

  it("adds nothing when nothing finished", () => {
    const rows = turn();
    expect(withCompletionsCarried(rows, [])).toBe(rows);
    expect(withCompletionsCarried(rows, undefined)).toBe(rows);
  });
});
