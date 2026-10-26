/**
 * The irreversible floor honors a yes the user already gave in the chat, and
 * only that: the agent named the target, the user said yes without a hedge,
 * and the command is one act on exactly what was named.
 */
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { applyIrreversibleFloor } from "../approval-decision.js";
import { chatTurnOf, consentedInChat } from "./chat-consent.js";

const ASKED = "The branch `agent/field-agent-1-mvohb7r0` only holds tcl-recipes-export.json, which is byte-identical on main. Want me to force-delete it?";
const floor = (command: string, user: string, assistant = ASKED) =>
  applyIrreversibleFloor("allow-with-rollback", "bash", { command }, { user, assistant });

describe("a yes in the chat to the act the agent named", () => {
  // Live 2026-10-26: "Approved to remove it" and the card still asked, then
  // timed out with nobody at the desktop.
  it("runs without a second card", () => {
    expect(floor("git branch -D agent/field-agent-1-mvohb7r0", "Approved to remove it let's hit the two follow ups")).toBe("allow-with-rollback");
    expect(floor("git branch -D agent/field-agent-1-mvohb7r0", "yes")).toBe("allow-with-rollback");
    expect(floor("rm -rf build/cache", "go ahead", "I can clear build/cache — it's 2 GB of stale output. OK?")).toBe("allow-with-rollback");
  });

  it("still asks for anything the agent did not name, a hedged answer, or a chained command", () => {
    expect(floor("git branch -D main", "yes")).toBe("ask");
    expect(floor("git branch -D agent/field-agent-1-mvohb7r0", "yes but wait, check main first")).toBe("ask");
    expect(floor("git branch -D agent/field-agent-1-mvohb7r0", "what's on it?")).toBe("ask");
    expect(floor("git branch -D agent/field-agent-1-mvohb7r0 && rm -rf ~/work", "yes")).toBe("ask");
    expect(floor("rm -rf dist", "yes", "The distribution build looks stale.")).toBe("ask");
    expect(floor("git branch -D agent/field-agent-1-mvohb7r0", "thanks for the summary")).toBe("ask");
    expect(applyIrreversibleFloor("allow", "bash", { command: "git branch -D agent/field-agent-1-mvohb7r0" })).toBe("ask");
  });

  it("never relaxes a deny or a profile that asks", () => {
    expect(applyIrreversibleFloor("deny", "bash", { command: "git branch -D agent/field-agent-1-mvohb7r0" }, { user: "yes", assistant: ASKED })).toBe("deny");
    expect(applyIrreversibleFloor("ask", "bash", { command: "git branch -D agent/field-agent-1-mvohb7r0" }, { user: "yes", assistant: ASKED })).toBe("ask");
  });
});

describe("chatTurnOf", () => {
  it("pairs the user's latest message with the agent message it answered", () => {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "clean up the repo" },
      { role: "assistant", content: ASKED },
      { role: "user", content: "yes" },
    ];
    expect(chatTurnOf(msgs)).toEqual({ user: "yes", assistant: ASKED });
    expect(consentedInChat("git branch -D agent/field-agent-1-mvohb7r0", chatTurnOf(msgs))).toBe(true);
  });

  it("has nothing to pair with when there is no human message", () => {
    expect(chatTurnOf(undefined)).toEqual({ user: "" });
  });
});
