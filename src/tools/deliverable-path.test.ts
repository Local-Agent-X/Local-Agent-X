import { describe, it, expect } from "vitest";
import { ESSENTIAL_TOOLS_ORDER, maxToolsForTier, shrinkToolsForTier } from "./tier-tool-set.js";
import { binaryContainerRejection } from "./syntax-validate.js";
import type { ToolDefinition } from "../types.js";

// Live failure 2026-09-16 (muse-glimmer:30b, medium tier): asked to research
// killer whales and "create a powerpoint with photos", the model called
// generate_image three times (that tool IS essential), then wrote an 11-byte
// text file named orca-communication.pptx containing the word "placeholder"
// and replied "It's built... assembled the PowerPoint with real photos".
// Server logs for the same day: across 27 shrink decisions the two intent
// slots went to edit_lines+multi_edit on 21 of them — both redundant with the
// essential `edit` — and `presentation` won a slot exactly once. The tool that
// WAS the task never reached the schema.
//
// Same class as credential-path.test.ts: a tier filter removing the capability
// that makes the safe/correct action possible, leaving only wrong options.
const DELIVERABLE_PATH = ["presentation", "document", "spreadsheet", "pdf"] as const;

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} does a thing that is described at some length for a strong model to read.`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  } as unknown as ToolDefinition;
}

describe("the deliverable path survives tier shrinking", () => {
  it("keeps every artifact producer in the medium set", () => {
    for (const name of DELIVERABLE_PATH) {
      expect(ESSENTIAL_TOOLS_ORDER, `${name} must not be intent-gated`).toContain(name);
    }
  });

  it("still reaches a medium model when the catalog is far larger than the cap", () => {
    const catalog = [
      ...ESSENTIAL_TOOLS_ORDER.map(tool),
      ...Array.from({ length: 80 }, (_, i) => tool(`filler_${i}`)),
    ];
    const kept = shrinkToolsForTier(catalog, "medium", catalog).map((t) => t.name);
    for (const name of DELIVERABLE_PATH) expect(kept).toContain(name);
  });

  it("does not promote the deliverable path above the weak-tier cut", () => {
    // A weak model keeps the first 8 and cannot drive a deck build; it must not
    // lose read/write/edit/bash to make room for one.
    const weakCut = ESSENTIAL_TOOLS_ORDER.slice(0, maxToolsForTier("weak"));
    for (const name of DELIVERABLE_PATH) expect(weakCut).not.toContain(name);
  });
});

describe("a binary container cannot be faked with text", () => {
  it("rejects the exact write that shipped the fake deck, naming the right tool", () => {
    const msg = binaryContainerRejection("workspace/orca-communication.pptx", "placeholder");
    expect(msg).toBeTruthy();
    expect(msg).toContain("presentation");
    expect(msg, "the model must not be able to read this as 'write it differently'")
      .toContain("do NOT report the deliverable as produced");
  });

  it("covers every container format with its own producer", () => {
    for (const [path, wanted] of [
      ["a.pptx", "presentation"], ["a.docx", "document"],
      ["a.xlsx", "spreadsheet"], ["a.pdf", "pdf"],
    ] as const) {
      expect(binaryContainerRejection(path, "some text"), path).toContain(wanted);
    }
  });

  it("lets real container bytes through", () => {
    const zipMagic = "PK" + String.fromCharCode(3, 4);
    expect(binaryContainerRejection("a.pptx", zipMagic + "rest-of-the-zip")).toBeNull();
    expect(binaryContainerRejection("a.pdf", "%PDF-1.7\nbody")).toBeNull();
  });

  it("never touches ordinary text files", () => {
    for (const p of ["notes.md", "index.html", "a.txt", "src/x.ts", "data.json", "noext"]) {
      expect(binaryContainerRejection(p, "placeholder"), p).toBeNull();
    }
  });
});
