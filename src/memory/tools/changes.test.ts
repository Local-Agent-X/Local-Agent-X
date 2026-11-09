import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../index.js";
import { authorizeTestFactMutations } from "../test-promotion.test-helper.js";
import { createChangesTool, createUndoTool } from "./changes.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-changes-tool-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("memory_changes and memory_undo", () => {
  it("answer what happened to a memory, and put it back on the user's word", async () => {
    const changes = createChangesTool(memory);
    const undo = createUndoTool(memory);
    const id = memory.rememberFact("@Reta vial is 50 mg with 2 mL bac water", { kind: "world", sourceFile: "agent-tool:user-statement" }).fact!.id!;
    memory.invalidateFact(id, { by: "agent", reason: "superseded by 9: semaglutide protocol" });

    const listed = await changes.execute({ query: "reta vial" });
    expect(listed.content).toMatch(/change #\d+ · end memory #\d+ by agent .*50 mg.*semaglutide protocol/);
    const change = Number(/change #(\d+)/.exec(listed.content)![1]);

    // An undo the user did not ask for is put to them; one they asked for is not.
    expect(undo.confirmWithUser({ change }, { userText: "what happened to my reta dose?" })).toContain(`#${change}`);
    expect(undo.confirmWithUser({ change }, { userText: "yes put it back" })).toBeNull();

    expect(await undo.execute({ change, _sessionId: "dream-123" })).toMatchObject({ isError: true });
    const undone = await undo.execute({ change, _sessionId: "chat-1" });
    expect(undone.isError).toBeUndefined();
    expect(undone.content).toContain("current again");
    expect(memory.recallByEntity("reta").map((f) => f.id)).toContain(id);
  });
});
