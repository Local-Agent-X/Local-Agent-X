// A local chat's head keeps the memory context it started with; the lines
// memory gains later are told once, in the message's row (local-memory-pin.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_TOLD_LINES, _resetMemoryPinsForTests, pinMemoryContext } from "./local-memory-pin.js";

const block = (...facts: string[]) => ["--- MEMORY CONTEXT ---", "<core_memory>", ...facts, "</core_memory>"].join("\n");

describe("pinMemoryContext", () => {
  beforeEach(() => _resetMemoryPinsForTests());

  it("builds the head from the chat's first block and reports nothing while memory is unchanged", () => {
    const first = block("- likes tea");
    expect(pinMemoryContext("s", first)).toEqual({ head: first, changes: "" });
    expect(pinMemoryContext("s", first)).toEqual({ head: first, changes: "" });
  });

  it("keeps the first head when memory gains a line, and tells that line once", () => {
    const first = block("- likes tea");
    pinMemoryContext("s", first);
    const gained = pinMemoryContext("s", block("- likes tea", "- has a pothos named Sprocket"));
    expect(gained.head).toBe(first);
    expect(gained.changes).toContain("- has a pothos named Sprocket");
    expect(gained.changes).not.toContain("- likes tea");
    expect(pinMemoryContext("s", block("- likes tea", "- has a pothos named Sprocket"))).toEqual({ head: first, changes: "" });
  });

  it("says nothing about lines that left the block: a fact below the cut, or a degraded build, is still in memory", () => {
    const first = block("- likes tea", "- lives in McKinney");
    pinMemoryContext("s", first);
    expect(pinMemoryContext("s", "--- MEMORY CONTEXT ---")).toEqual({ head: first, changes: "" });
    // and a line that returns was already told by the head
    expect(pinMemoryContext("s", first)).toEqual({ head: first, changes: "" });
  });

  it("rebuilds the head from current memory once the told lines outgrow the cap", () => {
    pinMemoryContext("s", block("- likes tea"));
    const many = Array.from({ length: MAX_TOLD_LINES + 1 }, (_, i) => `- fact ${i}`);
    const current = block("- likes tea", ...many);
    expect(pinMemoryContext("s", current)).toEqual({ head: current, changes: "" });
  });

  it("pins each chat on its own", () => {
    pinMemoryContext("a", block("- likes tea"));
    const b = block("- likes coffee");
    expect(pinMemoryContext("b", b)).toEqual({ head: b, changes: "" });
  });
});
