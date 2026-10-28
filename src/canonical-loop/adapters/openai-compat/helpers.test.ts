import { describe, it, expect } from "vitest";
import { extractText, byteLengthUtf8 } from "./helpers.js";

describe("openai-compat helpers", () => {
  it("extractText probes string and {text} shapes", () => {
    expect(extractText("hi")).toBe("hi");
    expect(extractText({ text: "yo" })).toBe("yo");
    expect(extractText(null)).toBe("");
  });

  it("byteLengthUtf8 counts multi-byte characters", () => {
    expect(byteLengthUtf8("abc")).toBe(3);
    expect(byteLengthUtf8("é")).toBe(2);
  });
});
