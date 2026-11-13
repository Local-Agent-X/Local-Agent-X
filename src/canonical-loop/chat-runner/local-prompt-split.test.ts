/**
 * The local wire's [head | trailing row] split of the system prompt.
 *
 * Two things are pinned. The split itself: per-op sections go to the tail in
 * order, everything else stays in the head in order, and head+tail account
 * for every byte. And the classification's COVERAGE: every section id the
 * builders can emit is in exactly one of the two sets, checked by scanning the
 * builders' source, so a section added later fails here instead of silently
 * breaking the prefix (an unclassified id lands in the head by default and
 * re-prefills the tools and history at every user message — the exact thing
 * the split exists to stop).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { HEAD_SECTION_IDS, TRAILING_SECTION_IDS, localPromptSplit, recalledContextText, splitPromptForStablePrefix } from "./local-prompt-split.js";
import { RECALLED_CONTEXT_CLOSE, RECALLED_CONTEXT_OPEN } from "../../harness-text.js";
import type { RenderedPromptSection } from "../../context/system-prompt-builder.js";

/** The split reads id and text only; the measurement is irrelevant to it. */
function section(id: string, text: string, type: "static" | "dynamic" = "dynamic"): RenderedPromptSection {
  return { id, label: id, type, policy: "required", text } as unknown as RenderedPromptSection;
}

/** Every `id: "…"` and every `["id", "Label", …]` tuple in the files that add sections. */
function emittedSectionIds(): Set<string> {
  const files = [
    "src/context/system-prompt-builder.ts",
    "src/context/recall-reflex-section.ts",
    "src/agent-request/prepare-request/build-system-prompt.ts",
    "src/agent-request/prepare-request.ts",
    "src/canonical-loop/chat-runner/create-op.ts",
    "src/canonical-loop/agent-runner/prompt.ts",
    "src/server/voice-prompt-plan.ts",
  ];
  const ids = new Set<string>();
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    for (const m of src.matchAll(/\bid: "([a-z][a-z0-9-]*)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\[\s*"([a-z][a-z0-9-]*)",\s*"[^"]+",\s*"(?:required|degradable)"/g)) ids.add(m[1]);
  }
  return ids;
}

describe("splitPromptForStablePrefix", () => {
  it("puts per-op sections in the tail, keeps everything else in the head, and loses no bytes", () => {
    const sections = [
      section("core-identity/identity", "IDENTITY ", "static"),
      section("core-identity/core-rules", "RULES ", "static"),
      section("tool-guidance", "TOOLS ", "static"),
      section("context-block", "MEMORY-CONTEXT "),
      section("context-block-volatile", "TODAY "),
      section("relevant-memories", "RECALL "),
      section("file-access", "FILE-ACCESS "),
      section("notifications", "NOTIFY "),
      section("model-family-rider", "RIDER "),
      section("canary", "CANARY "),
    ];
    const { head, tail, tailIds } = splitPromptForStablePrefix(sections);
    // The memory context's stable half (profile, core_memory) is head: it
    // rode the tail whole until 2026-11-02, re-read with every message.
    expect(head).toBe("IDENTITY RULES TOOLS MEMORY-CONTEXT FILE-ACCESS RIDER CANARY ");
    expect(tail).toBe("TODAY RECALL NOTIFY ");
    expect(tailIds).toEqual(["context-block-volatile", "relevant-memories", "notifications"]);
    expect(head.length + tail.length).toBe(sections.reduce((n, s) => n + s.text.length, 0));
  });

  it("an op with no per-op section has an empty tail — nothing is appended for nothing", () => {
    const { head, tail } = splitPromptForStablePrefix([section("core-identity/identity", "X", "static"), section("canary", "C")]);
    expect(head).toBe("XC");
    expect(tail).toBe("");
  });

  it("the two sets are disjoint", () => {
    for (const id of TRAILING_SECTION_IDS) expect(HEAD_SECTION_IDS.has(id), id).toBe(false);
  });

  it("every section id the builders emit is classified as head or tail", () => {
    const emitted = emittedSectionIds();
    expect(emitted.size).toBeGreaterThan(20);
    const unclassified = [...emitted].filter((id) => !HEAD_SECTION_IDS.has(id) && !TRAILING_SECTION_IDS.has(id));
    expect(unclassified, "add each to HEAD_SECTION_IDS (session-stable) or TRAILING_SECTION_IDS (rebuilt per op)").toEqual([]);
    // And nothing classified is a ghost the builders no longer emit.
    // `core-identity` is the family of every base-prompt part (core-identity/<heading>).
    const ghosts = [...HEAD_SECTION_IDS, ...TRAILING_SECTION_IDS].filter((id) => id !== "core-identity" && !emitted.has(id));
    expect(ghosts).toEqual([]);
  });
});

describe("localPromptSplit / recalledContextText", () => {
  const sections = [section("core-identity/identity", "IDENTITY ", "static"), section("relevant-memories", "RECALL ")];

  it("splits a local model's prompt and leaves a cloud model's whole", () => {
    expect(localPromptSplit({ provider: "local", model: "qwen3.8:27b", renderedPromptSections: sections }, "s-split")?.tail).toBe("RECALL ");
    expect(localPromptSplit({ provider: "openai", model: "gpt-5", renderedPromptSections: sections }, "s-split")).toBeNull();
  });

  it("keeps the chat's first memory context in the head and leads the tail with what memory gained", () => {
    const withMemory = (core: string) => [section("context-block", core), ...sections];
    const first = localPromptSplit({ provider: "local", model: "qwen3.8:27b", renderedPromptSections: withMemory("- likes tea\n") }, "s-pin");
    const second = { provider: "local", model: "qwen3.8:27b", renderedPromptSections: withMemory("- likes tea\n- has a pothos\n") };
    const split = localPromptSplit(second, "s-pin");
    expect(split?.head).toBe(first?.head);
    expect(split?.tail).toMatch(/^<memory_changes>\n[^]*\n- has a pothos\n<\/memory_changes>\n\nRECALL $/);
    // The adapter and the op seed read one split: asking again tells nothing twice.
    expect(localPromptSplit(second, "s-pin")).toBe(split);
  });

  it("frames the tail as recalled data, and renders nothing for nothing", () => {
    expect(recalledContextText(" RECALL \n")).toBe(`${RECALLED_CONTEXT_OPEN}\nRECALL\n${RECALLED_CONTEXT_CLOSE}`);
    expect(recalledContextText("  \n ")).toBeNull();
  });
});
