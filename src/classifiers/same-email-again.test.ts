import { describe, expect, it } from "vitest";
import { sameEmailAgain } from "./same-email-again.js";

const sent = { subject: "Line cook position", text: "Thanks! Thursday at 2 works for the interview." };
const draft = { subject: "Re: Line cook position", text: "Thank you, I can come Thursday at 2pm." };

describe("sameEmailAgain", () => {
  it("reads a verdict and its reason, and shows the model both emails", async () => {
    let prompt = "";
    const v = await sameEmailAgain(sent, draft, { _llm: async (_s, u) => { prompt = u; return '{"verdict":"same","why":"Both accept Thursday at 2."}'; } });
    expect(v).toEqual({ verdict: "same", why: "Both accept Thursday at 2." });
    expect(prompt).toContain("ALREADY SENT");
    expect(prompt).toContain("Thursday at 2 works");
    expect(prompt).toContain("I can come Thursday at 2pm");
  });

  it("is null when no model answers, or the answer is not a verdict", async () => {
    expect(await sameEmailAgain(sent, draft, { _llm: async () => null })).toBeNull();
    expect(await sameEmailAgain(sent, draft, { _llm: async () => '{"verdict":"maybe"}' })).toBeNull();
  });
});
