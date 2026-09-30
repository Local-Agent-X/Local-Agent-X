import { describe, it, expect } from "vitest";
import type { MemoryIndex } from "./index.js";
import { createMemoryTools } from "./tools.js";
import { createSearchTools } from "./tools/search.js";
import { createSaveTools } from "./tools/save.js";
import { createFactsTools } from "./tools/facts.js";
import { createProcessTools } from "./tools/process.js";

// createMemoryTools picks tools out of the family factories BY NAME. That
// guards against positional drift, but it also means a tool a factory builds
// and the list forgets is silently dropped: search_past_sessions was built by
// createSearchTools from 2026-05-23 and never registered until 2026-09-30,
// while the system prompt told the model to call it. Every name a factory
// builds must come out the other side.
describe("createMemoryTools registers every tool the family factories build", () => {
  const memory = {} as MemoryIndex; // the factories only capture it in closures
  const registered = new Set(createMemoryTools(memory).map((t) => t.name));

  for (const [family, build] of [
    ["search", createSearchTools],
    ["save", createSaveTools],
    ["facts", createFactsTools],
    ["process", createProcessTools],
  ] as const) {
    it(`${family}: nothing is built and dropped`, () => {
      const built = build(memory).map((t) => t.name);
      expect(built.length).toBeGreaterThan(0);
      for (const name of built) expect(registered, `${name} is built by the ${family} factory but not registered`).toContain(name);
    });
  }

  it("search_past_sessions is registered (the ghost the model was told to call)", () => {
    expect(registered).toContain("search_past_sessions");
  });
});
