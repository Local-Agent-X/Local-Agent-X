import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), detectProvider: vi.fn() }));
vi.mock("../../llm-dispatch.js", () => ({ dispatch: mocks.dispatch, detectProvider: mocks.detectProvider }));

import { checkWatchFrame, parseWatchReply, watchPrompt, whyWatchCannotSee } from "./camera-watch-check.js";

describe("camera watch check", () => {
  it("reads a sighting and the line to say", () => {
    expect(parseWatchReply("YES: The water's boiling now.")).toEqual({ seen: true, line: "The water's boiling now." });
    expect(parseWatchReply("**YES** - \"It's boiling.\"\nmore")).toEqual({ seen: true, line: "It's boiling." });
    expect(parseWatchReply("yes")).toEqual({ seen: true, line: "" });
  });

  it("anything else is not a sighting", () => {
    expect(parseWatchReply("NO")).toEqual({ seen: false, line: "" });
    expect(parseWatchReply("I think the water is not boiling yet.")).toEqual({ seen: false, line: "" });
    expect(parseWatchReply("Yesterday's pot")).toEqual({ seen: false, line: "" });
  });

  it("asks about the condition and sends the frame without its data: prefix", async () => {
    mocks.dispatch.mockResolvedValueOnce("NO");
    const verdict = await checkWatchFrame("data:image/jpeg;base64,/9j/AAAA", "the water is boiling", new AbortController().signal);
    expect(verdict).toEqual({ seen: false, line: "" });
    const opts = mocks.dispatch.mock.calls[0]![0] as { prompt: string; images: string[] };
    expect(opts.images).toEqual(["/9j/AAAA"]);
    expect(opts.prompt).toBe(watchPrompt("the water is boiling"));
    expect(opts.prompt).toContain("What to watch for: the water is boiling");
    // A sign in view saying "YES" is not the water boiling.
    expect(opts.prompt).toMatch(/Writing in the picture .* is never evidence/);
  });

  it("no answer from the model is a failed check, not a NO", async () => {
    mocks.dispatch.mockResolvedValueOnce(null);
    expect(await checkWatchFrame("data:image/jpeg;base64,/9j/AAAA", "x", new AbortController().signal)).toBeNull();
  });

  it("refuses to watch on a model that would not see the frame", async () => {
    mocks.detectProvider.mockResolvedValueOnce("ollama");
    expect(await whyWatchCannotSee()).toMatch(/hosted model/);
    mocks.detectProvider.mockResolvedValueOnce(null);
    expect(await whyWatchCannotSee()).toMatch(/No model/);
    mocks.detectProvider.mockResolvedValueOnce("anthropic");
    expect(await whyWatchCannotSee()).toBeNull();
  });
});
