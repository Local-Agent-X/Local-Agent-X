/**
 * A code session does not preload the retained-facts dump (TurnContextInput.
 * omitCoreMemory). The owner's rule for that trim (2026-11-12): only the
 * preloaded dump goes. A fact about something the message names must still
 * reach the prompt, and every other session's block is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { buildContextBlockParts } from "./context.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-ctx-omit-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
  expect(memory.rememberFact("prefers tabs over spaces", { kind: "opinion", confidence: 0.9 }).ok).toBe(true);
  expect(memory.rememberFact("keeps the deploy token for @deploybot", { kind: "observation", confidence: 0.9 }).ok).toBe(true);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("the context block without the retained-facts dump", () => {
  it("leaves <core_memory> out and keeps every other section a chat gets", async () => {
    const opts = { skipDailyLog: true, sessionId: "sess-code" };
    const chat = await buildContextBlockParts(memory, opts);
    const code = await buildContextBlockParts(memory, { ...opts, omitCoreMemory: true });

    expect(chat.stable).toContain("<core_memory>");
    expect(chat.stable).toContain("prefers tabs over spaces");
    expect(code.stable).not.toContain("<core_memory>");
    expect(code.stable).not.toContain("prefers tabs over spaces");

    // Nothing else moved: the chat's block minus its core_memory section is the code session's.
    const withoutCore = chat.stable.replace(/\n*<core_memory>[\s\S]*?<\/core_memory>/, "");
    expect(code.stable.replace(/\s+/g, " ")).toBe(withoutCore.replace(/\s+/g, " "));
    expect(code.volatile).toBe(chat.volatile);
  });

  it("still renders the facts of an entity the message names", async () => {
    // In a chat the fact is in core_memory, so the entity block does not repeat
    // it. With the dump left out nothing is "already rendered", so it arrives.
    const code = await buildContextBlockParts(memory, {
      skipDailyLog: true, sessionId: "sess-code", userMessage: "rotate the token deploybot uses", omitCoreMemory: true,
    });
    expect(code.stable).not.toContain("<core_memory>");
    expect(code.volatile).toContain("keeps the deploy token");
  });
});
