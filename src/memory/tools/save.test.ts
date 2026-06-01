/**
 * Regression tests for the memory_save misfired-durable-fact guard.
 *
 * Bug: a worker called memory_save with a malformed {key, value} shape (and
 * for content that needed `remember`). memory_save only appends to the
 * TRANSIENT daily log and only accepts `content`, so the stray args were
 * dropped and the model was told "saved!" while nothing durable persisted.
 * Fix: stray args (anything but content/_sessionId) return a non-terminal
 * retry hint pointing at `remember`, and do NOT touch the daily log.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../../memory/index.js";
import { createSaveTools } from "./save.js";

let tempDir: string;
let memory: MemoryIndex;

function memorySaveTool() {
  const tool = createSaveTools(memory).find((t) => t.name === "memory_save");
  if (!tool) throw new Error("memory_save tool not found");
  return tool;
}

function dailyLogContents(): string {
  const p = memory.getDailyLogPath();
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-save-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("memory_save misfired-durable-fact guard", () => {
  it("redirects a stray {key, value} call to `remember` without writing the daily log", async () => {
    const tool = memorySaveTool();
    const res = await tool.execute({ key: "favorite_color", value: "blue" });

    expect(res.isError).toBe(false);
    expect(res.content).toMatch(/remember/);
    expect(res.content).toMatch(/key/);
    expect(res.content).toMatch(/value/);
    expect(res.content).toMatch(/not applied/i);
    // No daily-log write happened.
    expect(dailyLogContents()).toBe("");
  });

  it("names every stray key seen in the hint", async () => {
    const tool = memorySaveTool();
    const res = await tool.execute({ title: "X", name: "Y", fact: "Z" });

    expect(res.isError).toBe(false);
    expect(res.content).toMatch(/title/);
    expect(res.content).toMatch(/name/);
    expect(res.content).toMatch(/fact/);
    expect(dailyLogContents()).toBe("");
  });

  it("still appends a plain transient content string to the daily log", async () => {
    const tool = memorySaveTool();
    const res = await tool.execute({
      content: "started debugging the boot cache for this session",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/daily log/i);
    expect(dailyLogContents()).toMatch(/started debugging the boot cache/);
  });

  it("ignores _sessionId — it is not a stray arg", async () => {
    const tool = memorySaveTool();
    const res = await tool.execute({
      content: "looking into the voice sidecar warm path",
      _sessionId: "sess-123",
    });

    expect(res.isError).toBeUndefined();
    expect(dailyLogContents()).toMatch(/voice sidecar warm path/);
  });
});
