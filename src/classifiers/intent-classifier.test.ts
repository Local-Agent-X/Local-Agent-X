import { describe, it, expect, vi } from "vitest";

import { mightNeedToolForcing, hasLiteralToolCall, classifyIntent } from "./intent-classifier.js";

/** Run classifyIntent with the LLM returning `raw` as JSON, exercising the real schema. */
async function classifyRaw(raw: unknown) {
  return classifyIntent("build me something", { _llm: async () => JSON.stringify(raw) });
}

describe("classifyIntent schema — graded verdict (kind + mode)", () => {
  it("honors an explicit force mode on a non-free kind", async () => {
    expect(await classifyRaw({ kind: "build_app", mode: "force", reason: "specified" })).toEqual({
      kind: "build_app", mode: "force", reason: "specified",
    });
  });

  it("fails soft: a missing mode defaults to lean, never force", async () => {
    expect(await classifyRaw({ kind: "build_app", reason: "thin" })).toEqual({
      kind: "build_app", mode: "lean", reason: "thin",
    });
  });

  it("fails soft: a garbled mode defaults to lean", async () => {
    expect((await classifyRaw({ kind: "agent_spawn", mode: "maybe?", reason: "" }))?.mode).toBe("lean");
  });

  it("normalizes mode casing/whitespace", async () => {
    expect((await classifyRaw({ kind: "self_edit", mode: " Force ", reason: "" }))?.mode).toBe("force");
  });

  it("free always carries lean, even if the LLM says force", async () => {
    expect(await classifyRaw({ kind: "free", mode: "force", reason: "chat" })).toEqual({
      kind: "free", mode: "lean", reason: "chat",
    });
  });

  it("still rejects an invalid kind outright", async () => {
    expect(await classifyRaw({ kind: "build_everything", mode: "force", reason: "" })).toBeNull();
    expect(await classifyRaw(null)).toBeNull();
  });

  it("returns null on non-JSON garbage after the single retry — fallback path", async () => {
    const llm = vi.fn(async () => "definitely a build_app, force it");
    expect(await classifyIntent("build me something", { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("returns null without retrying when the LLM is unavailable", async () => {
    const llm = vi.fn(async () => null);
    expect(await classifyIntent("build me something", { _llm: llm })).toBeNull();
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("recovers on the retry when the first reply has a bad kind", async () => {
    const llm = vi
      .fn()
      .mockResolvedValueOnce(`{"kind":"build_everything","mode":"force","reason":"nope"}`)
      .mockResolvedValueOnce(`{"kind":"build_app","mode":"force","reason":"ok"}`);
    expect(await classifyIntent("build me something", { _llm: llm })).toEqual({
      kind: "build_app", mode: "force", reason: "ok",
    });
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("caps a runaway reason at 240 chars and coerces a non-string reason", async () => {
    expect((await classifyRaw({ kind: "build_app", mode: "force", reason: "r".repeat(500) }))?.reason)
      .toBe("r".repeat(240));
    expect((await classifyRaw({ kind: "build_app", mode: "force", reason: 42 }))?.reason).toBe("");
  });
});

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
    expect(mightNeedToolForcing("research the top note-taking apps")).toBe(true);
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
