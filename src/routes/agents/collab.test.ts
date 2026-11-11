// Who may join a collab, and what a tab is told about one (routes/agents/collab.ts).
import { describe, expect, it } from "vitest";
import { collabView, parseMembers } from "./collab.js";
import type { Collab } from "../../agency/collab.js";

const signedIn = () => true;

describe("the members a collab starts with", () => {
  it("takes two to four different models and names each by its model", () => {
    const out = parseMembers([{ provider: "anthropic", model: "opus-x" }, { provider: "xai", model: "grok-x" }], signedIn);
    expect(out).toEqual({ members: [
      { provider: "anthropic", model: "opus-x", label: "opus-x" },
      { provider: "xai", model: "grok-x", label: "grok-x" },
    ] });
  });

  it("refuses one model, five models, and the same model twice", () => {
    const m = (provider: string, model: string) => ({ provider, model });
    expect(parseMembers([m("xai", "g")], signedIn)).toEqual({ error: "A collab has 2 to 4 models." });
    expect(parseMembers([m("xai", "a"), m("xai", "b"), m("xai", "c"), m("xai", "d"), m("xai", "e")], signedIn)).toEqual({ error: "A collab has 2 to 4 models." });
    expect(parseMembers([m("xai", "g"), m("xai", "g")], signedIn)).toEqual({ error: "Each member must be a different model." });
    expect(parseMembers("nope", signedIn)).toEqual({ error: "A collab has 2 to 4 models." });
  });

  it("refuses a provider that is not a provider, and one that is not signed in", () => {
    expect(parseMembers([{ provider: "nope", model: "x" }, { provider: "xai", model: "g" }], signedIn)).toHaveProperty("error");
    const out = parseMembers([{ provider: "anthropic", model: "o" }, { provider: "xai", model: "g" }], (p) => p !== "xai");
    expect("error" in out && out.error).toContain("is not signed in");
  });

  it("says which provider when two serve a model of the same name", () => {
    const out = parseMembers([{ provider: "openai", model: "same" }, { provider: "codex", model: "same" }], signedIn);
    expect("members" in out && out.members.map((x) => x.label)).toEqual(["same (openai)", "same (codex)"]);
  });
});

describe("what a tab is told about a collab", () => {
  it("lists the host's chat then each member's, with how far each has got", () => {
    const c: Collab = {
      id: "collab-1", hostId: "host", hostTitle: "Host", question: "Q?", rounds: 2, round: 1, state: "running", startedAt: "2026-11-11T00:00:00.000Z",
      members: [
        { sessionId: "m1", provider: "anthropic", model: "o", label: "o", answers: ["one"] },
        { sessionId: "m2", provider: "xai", model: "g", label: "g", answers: [], dropped: "it gave no answer" },
      ],
    };
    const view = collabView(c);
    expect(view.chatIds).toEqual(["host", "m1", "m2"]);
    expect(view.members).toEqual([
      { sessionId: "m1", label: "o", provider: "anthropic", model: "o", answered: 1, dropped: "" },
      { sessionId: "m2", label: "g", provider: "xai", model: "g", answered: 0, dropped: "it gave no answer" },
    ]);
    // The answers themselves stay on the server: each is in its member's chat.
    expect(JSON.stringify(view)).not.toContain("one");
    expect(view.note).toBe("");
  });
});
