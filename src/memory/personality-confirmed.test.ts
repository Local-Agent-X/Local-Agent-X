import { describe, it, expect, vi } from "vitest";
import { dedupeProfileMarkdownConfirmed } from "./personality-confirmed.js";
import { dedupeProfileMarkdown } from "./personality.js";

const PROFILE = [
  "# Heart",
  "",
  "## Language Preference",
  "- Always greet in Spanish",
  "",
  "## Greeting Style",
  "- No Spanish greetings",
  "",
].join("\n");

describe("dedupeProfileMarkdownConfirmed", () => {
  it("deletes the losing bullet when the LLM confirms the contradiction", async () => {
    const confirm = vi.fn(async () => true);
    const out = await dedupeProfileMarkdownConfirmed(PROFILE, confirm);
    expect(out).not.toContain("Always greet in Spanish");
    expect(out).toContain("No Spanish greetings");
    expect(confirm).toHaveBeenCalledWith({
      keepText: "- No Spanish greetings",
      dropText: "- Always greet in Spanish",
    });
  });

  it("keeps BOTH bullets when the LLM vetoes the pair", async () => {
    const confirm = vi.fn(async () => false);
    const out = await dedupeProfileMarkdownConfirmed(PROFILE, confirm);
    expect(out).toContain("Always greet in Spanish");
    expect(out).toContain("No Spanish greetings");
  });

  it("fails open to the regex verdict on null and on confirmer errors", async () => {
    for (const confirm of [async () => null, async () => { throw new Error("down"); }]) {
      const out = await dedupeProfileMarkdownConfirmed(PROFILE, confirm as never);
      expect(out).not.toContain("Always greet in Spanish");
      expect(out).toContain("No Spanish greetings");
    }
  });

  it("makes no LLM calls when the sweep flags no pairs", async () => {
    const confirm = vi.fn();
    const clean = "# About Me\n\n- Name: Peter\n\n## Style\n- Prefers direct answers\n";
    await dedupeProfileMarkdownConfirmed(clean, confirm);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("matches the sync dedupe byte-for-byte when every pair is confirmed", async () => {
    const out = await dedupeProfileMarkdownConfirmed(PROFILE, async () => true);
    expect(out).toBe(dedupeProfileMarkdown(PROFILE));
  });
});
