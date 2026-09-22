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
import { HEAD_SECTION_IDS, TRAILING_SECTION_IDS, splitPromptForStablePrefix } from "./local-prompt-split.js";
import type { RenderedPromptSection } from "../../context/system-prompt-builder.js";

function section(id: string, text: string, type: "static" | "dynamic" = "dynamic"): RenderedPromptSection {
  return { id, label: id, type, policy: "required", text, measurement: { id, type, chars: text.length, estimatedTokens: 1 } } as RenderedPromptSection;
}

/** Every `id: "…"` and every `["id", "Label", …]` tuple in the files that add sections. */
function emittedSectionIds(): Set<string> {
  const files = [
    "src/context/system-prompt-builder.ts",
    "src/agent-request/prepare-request/build-system-prompt.ts",
    "src/agent-request/prepare-request.ts",
    "src/canonical-loop/chat-runner/create-op.ts",
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
      section("relevant-memories", "RECALL "),
      section("file-access", "FILE-ACCESS "),
      section("notifications", "NOTIFY "),
      section("model-family-rider", "RIDER "),
      section("canary", "CANARY "),
    ];
    const { head, tail, tailIds } = splitPromptForStablePrefix(sections);
    expect(head).toBe("IDENTITY RULES TOOLS FILE-ACCESS RIDER CANARY ");
    expect(tail).toBe("MEMORY-CONTEXT RECALL NOTIFY ");
    expect(tailIds).toEqual(["context-block", "relevant-memories", "notifications"]);
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
