import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { memoryRecallTool } from "./memory-recall.js";

// Minimal MemoryIndex stub: recall* return nothing (Facts DB empty), so the
// ONLY way the daily log surfaces is the date-window branch reading the file.
function stubMemory(memoryDir: string) {
  return {
    memoryDir,
    recallOpinions: () => [],
    recallByEntity: () => [],
    recallByKind: () => [],
    recallByTime: () => [],
    reinforceFacts: () => {},
  } as never;
}

describe("memory_recall date-window precedence", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-recall-"));
    writeFileSync(join(dir, "2026-04-16.md"), "## April 16\nShipped the recall fix.");
    writeFileSync(join(dir, "2026-05-07.md"), "## May 7\nPlanned the release.");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the daily log even when kind is ALSO passed (the Grok/Gemini regression)", async () => {
    // Grok sends kind:"observation" alongside since/until. Old code routed
    // that into recallByKind (date ignored, log never read) → "no memory".
    const tool = memoryRecallTool(stubMemory(dir));
    const res = await tool.execute({
      kind: "observation",
      since: "2026-04-16",
      until: "2026-04-17",
    });
    expect(res.content).toContain("Shipped the recall fix.");
  });

  it("reads the daily log even when entity AND kind are passed (live Grok shape)", async () => {
    // Grok actually sent {entity:"Peter", kind:"experience", since, until} for
    // "what did we do on april 16" — entity used to win and route to
    // recallByEntity (date ignored). Date must dominate entity AND kind.
    const tool = memoryRecallTool(stubMemory(dir));
    const res = await tool.execute({
      entity: "Peter",
      kind: "experience",
      since: "2026-04-16",
      until: "2026-04-17",
    });
    expect(res.content).toContain("Shipped the recall fix.");
  });

  it("reads the daily log for a date-only query (no kind)", async () => {
    const tool = memoryRecallTool(stubMemory(dir));
    const res = await tool.execute({ since: "2026-05-07", until: "2026-05-08" });
    expect(res.content).toContain("Planned the release.");
  });

  it("gives an honest empty answer naming nearby dates when the day has no log", async () => {
    // May 9 has no file; nearest is May 7. Must say so + forbid confabulation,
    // not stay silent (which reads as broken).
    const tool = memoryRecallTool(stubMemory(dir));
    const res = await tool.execute({
      kind: "observation",
      since: "2026-05-09",
      until: "2026-05-10",
    });
    expect(res.content).toContain("No activity was logged for 2026-05-09");
    expect(res.content).toContain("2026-05-07");
    expect(res.content).toMatch(/do NOT invent/i);
  });
});
