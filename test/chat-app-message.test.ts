// @vitest-environment happy-dom
//
// A message the app sent into a chat (a collab's brief, or the reports and
// claims record the starting chat writes the result from) is drawn as one line
// labelled App, with the whole text behind it (public/js/chat-app-message.js).
// What the user typed is never touched.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Collab } from "../src/agency/collab.js";
import { missingDisputesMessage, researchMessage, resultMessage, claimsRepairMessage } from "../src/agency/collab-messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../public/js/chat-app-message.js"), "utf8");
type Api = { summaryOf: (text: unknown) => string | null; apply: (node: HTMLElement, text: string, summary: string) => HTMLElement };
const api: Api = new Function(`${src}\nreturn laxAppMessage;`)();

const collab: Collab = {
  id: "collab-1", hostId: "host", hostTitle: "My (odd) chat", question: "Which battery?", steps: 3, depth: "standard", phase: "research", disputeRound: 1,
  state: "running", claims: [], startedAt: "2026-11-11T00:00:00.000Z",
  members: [
    { sessionId: "m1", provider: "anthropic", model: "opus", label: "opus", letter: "A", report: "REPORT" },
    { sessionId: "m2", provider: "xai", model: "grok", label: "grok", letter: "B", report: "REPORT" },
  ],
};

describe("a message the app sent", () => {
  it("is recognised from the messages a collab really sends, each with what it is", () => {
    expect(api.summaryOf(researchMessage(collab, collab.members[0]))).toBe("Collab: the brief for research");
    expect(api.summaryOf(claimsRepairMessage(collab))).toBe("Collab: the brief for research");
    expect(api.summaryOf(resultMessage(collab))).toBe("Collab finished: the models’ reports and the app’s record of their claims");
    expect(api.summaryOf(missingDisputesMessage(["A2"]))).toBe("A note from the app");
  });

  it("leaves what the user typed alone, even when it starts with a bracket or mentions a collab", () => {
    for (const typed of ["hello", "(a thought) what about sodium?", "(Collab, research.) is what I want", "", null, 42]) {
      expect(api.summaryOf(typed), String(typed)).toBeNull();
    }
  });

  it("draws the row as one line labelled App, with the whole text behind it", () => {
    const node = document.createElement("div");
    node.className = "msg user";
    node.innerHTML = `<div class="msg-label">You</div><div class="msg-body">x</div>`;
    const text = "(Collab, challenge. Sent by the app, not typed by the user.)\n\n<b>not markup</b>";
    api.apply(node, text, api.summaryOf(text)!);
    expect(node.classList.contains("app-message")).toBe(true);
    expect(node.querySelector(".msg-label")!.textContent).toBe("App");
    expect(node.querySelector("summary")!.textContent).toBe("Collab: the brief for challenge");
    expect(node.querySelector("details")!.open).toBe(false);
    // The whole text is there, as text.
    expect(node.querySelector(".app-message-text")!.textContent).toBe(text);
    expect(node.querySelector(".app-message-text b")).toBeNull();
  });
});
