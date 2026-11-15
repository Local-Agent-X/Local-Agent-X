import { describe, it, expect } from "vitest";
import { extractText } from "./helpers.js";

describe("openai-compat helpers", () => {
  it("extractText probes string and {text} shapes", () => {
    expect(extractText("hi")).toBe("hi");
    expect(extractText({ text: "yo" })).toBe("yo");
    expect(extractText(null)).toBe("");
  });
});
