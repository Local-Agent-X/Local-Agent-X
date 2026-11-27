// Label Check Sol, 2026-11-27: the agent asked "May I queue one internal Expo
// build?", the owner answered "Yes", and op_submit_async refused it as small
// talk after a finished job, so the agent asked him to type the request out
// word for word. A short reply to the agent's own question is a go-ahead.
import { describe, expect, it } from "vitest";
import { lastExchangeArgs } from "../../tool-execution/resolve-tool.js";
import { lastTurnOf } from "../../tool-execution/internal-args.js";
import { answersAQuestion } from "./op-submit-async.js";

describe("what a short reply answers", () => {
  it("is the assistant's message before the user's last one, not the turn's own narration", () => {
    const history = [
      { role: "user", content: "try because we've used it in other apps" },
      { role: "assistant", content: "The diagnostic compiled. May I queue one internal Expo build using your existing quota?" },
      { role: "user", content: "Yes" },
      { role: "assistant", content: "I verified the diagnostic commit. I'll queue the build now." },
    ];
    const turn = lastTurnOf(lastExchangeArgs(history));
    expect(turn.user).toBe("Yes");
    expect(turn.assistant).toBe("I verified the diagnostic commit. I'll queue the build now.");
    expect(turn.asked).toContain("May I queue one internal Expo build");
    expect(answersAQuestion(turn.asked)).toBe(true);
  });

  it("an acknowledgement of a finished job is not an answer: nothing was asked", () => {
    const history = [
      { role: "assistant", content: "The build finished and is installed on your Galaxy." },
      { role: "user", content: "ok thanks" },
    ];
    expect(answersAQuestion(lastTurnOf(lastExchangeArgs(history)).asked)).toBe(false);
  });

  it("reads a question that ends the message, even under a closing quote or emphasis", () => {
    expect(answersAQuestion("Shall I start it?")).toBe(true);
    expect(answersAQuestion("Say the word: **should I queue it?**")).toBe(true);
    expect(answersAQuestion("Do you want me to queue it?\n\n(It uses one of your 30 monthly builds.)")).toBe(true);
    expect(answersAQuestion("Done. It is installed.")).toBe(false);
    expect(answersAQuestion("")).toBe(false);
  });
});
