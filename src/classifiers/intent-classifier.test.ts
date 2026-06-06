import { describe, it, expect } from "vitest";
import { mightNeedToolForcing, hasLiteralToolCall } from "./intent-classifier.js";

describe("mightNeedToolForcing — pre-gate for the LLM intent classifier", () => {
  it("skips ordinary conversation (returns false → classifier not run)", () => {
    for (const m of [
      "hey what's up",
      "tell me about the whey supply crisis",
      "what do you think about that",
      "thanks, that helps",
      "how are you doing today",
    ]) {
      expect(mightNeedToolForcing(m)).toBe(false);
    }
  });

  it("runs on build/artifact requests", () => {
    for (const m of [
      "build me a kanban app",
      "create a dashboard for fastmail",
      "scaffold a todo page",
      "make a calculator",
      "design a landing site",
    ]) {
      expect(mightNeedToolForcing(m)).toBe(true);
    }
  });

  it("runs on delegation requests", () => {
    expect(mightNeedToolForcing("research the top GLP-1 supplements")).toBe(true);
    expect(mightNeedToolForcing("spawn a worker to review the kraken bot")).toBe(true);
    expect(mightNeedToolForcing("have an agent scan competitor pricing")).toBe(true);
  });

  it("runs on bug / broken-behavior reports", () => {
    expect(mightNeedToolForcing("the dark mode toggle doesn't work")).toBe(true);
    expect(mightNeedToolForcing("settings page won't save")).toBe(true);
    expect(mightNeedToolForcing("the chat UI freezes on paste")).toBe(true);
    expect(mightNeedToolForcing("fix the sidebar")).toBe(true);
  });

  it("is empty-safe", () => {
    expect(mightNeedToolForcing("")).toBe(false);
  });

  it("hasLiteralToolCall still detects pasted tool invocations", () => {
    expect(hasLiteralToolCall("call web_search({ query: 'x' })")).toBe(true);
    expect(hasLiteralToolCall("just a normal sentence")).toBe(false);
  });
});
