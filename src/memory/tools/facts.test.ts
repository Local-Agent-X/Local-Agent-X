/**
 * Regression tests for the `remember` multi-fact-blob guard.
 *
 * Bug: a worker crammed ~10 facts plus token names into a SINGLE `remember`
 * call as one giant blob. One blob = one un-queryable mega-fact instead of N
 * retrievable facts. Fix: a multi-line / over-long / many-sentence dump returns
 * a non-terminal retry hint (isError:false) telling the model to split it, and
 * does NOT call rememberFact. A single compact one-line fact still persists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../../memory/index.js";
import { createFactsTools } from "./facts.js";

let tempDir: string;
let memory: MemoryIndex;

function rememberTool() {
  const tool = createFactsTools(memory).find((t) => t.name === "remember");
  if (!tool) throw new Error("remember tool not found");
  return tool;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-facts-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("remember multi-fact-blob guard", () => {
  it("rejects a multi-line blob of several facts and does NOT call rememberFact", async () => {
    const spy = vi.spyOn(memory, "rememberFact");
    const tool = rememberTool();
    const res = await tool.execute({
      content:
        "User owns NutriShop McKinney.\n" +
        "User runs the Kraken trading bot.\n" +
        "User prefers terse responses.\n" +
        "User's wife is @Sam.",
    });

    expect(res.isError).toBe(false);
    expect(res.content).toMatch(/split/i);
    expect(res.content).toMatch(/not applied/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a >400-char single-line string with the split hint", async () => {
    const spy = vi.spyOn(memory, "rememberFact");
    const tool = rememberTool();
    const longLine = "User prefers business-suite-level dashboards " + "x".repeat(420);
    const res = await tool.execute({ content: longLine });

    expect(res.isError).toBe(false);
    expect(res.content).toMatch(/split/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("remembers a single compact one-line fact (rememberFact called, success string)", async () => {
    const spy = vi.spyOn(memory, "rememberFact");
    const tool = rememberTool();
    const res = await tool.execute({
      content: "User prefers business-suite-level dashboards because he runs multiple SaaS products",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/^Remembered/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not falsely reject a 2-sentence single-line fact under 400 chars", async () => {
    const spy = vi.spyOn(memory, "rememberFact");
    const tool = rememberTool();
    const res = await tool.execute({
      content: "User owns NutriShop McKinney. He runs it as a SaaS, not a white-label product.",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/^Remembered/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
