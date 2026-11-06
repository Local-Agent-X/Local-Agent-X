// memory_set_user_field is how a name a profile already gives is changed: on purpose, by
// the agent, with the conversation in view (the background pass only fills an empty
// one: auto-extract.ts). It sets the user's field in USER.md, and with profile
// "identity" the agent's own in IDENTITY.md ("call yourself Ari"), through the memory
// gate, which allows the write only for the target it was requested for.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../index.js";
import { describeMemoryPromotionRequest, stampTrustedUserPromotion } from "../promotion-gate.js";
import { createSaveTools } from "./save.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-set-field-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch { /* already closed */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* temp dir cleanup */ }
});

const memoryDir = (): string => (memory as unknown as { memoryDir: string }).memoryDir;

async function setField(args: Record<string, unknown>, said: string): Promise<{ content: string; isError?: boolean }> {
  const tool = createSaveTools(memory).find((t) => t.name === "memory_set_user_field")!;
  const request = describeMemoryPromotionRequest("memory_set_user_field", args, "default");
  stampTrustedUserPromotion(args, request!, { userMessage: said, evidenceSpan: said });
  return tool.execute(args) as Promise<{ content: string; isError?: boolean }>;
}

describe("memory_set_user_field", () => {
  it("sets the user's name in USER.md", async () => {
    writeFileSync(join(memoryDir(), "USER.md"), "# About Me\n- Name: Pierre\n", "utf-8");
    const out = await setField({ field: "Name", value: "Peter" }, "stop calling me Pierre, my name is Peter");
    expect(out.isError).toBeFalsy();
    expect(readFileSync(join(memoryDir(), "USER.md"), "utf-8")).toContain("- Name: Peter");
  });

  it("with profile identity, renames the agent in IDENTITY.md and leaves USER.md alone", async () => {
    writeFileSync(join(memoryDir(), "USER.md"), "# About Me\n- Name: Peter\n", "utf-8");
    writeFileSync(join(memoryDir(), "IDENTITY.md"), "# Agent Identity\n- Name: Primal\n- Vibe: direct\n", "utf-8");
    const out = await setField({ field: "Name", value: "Ari", profile: "identity" }, "call yourself Ari, your name is Ari");
    expect(out.isError).toBeFalsy();
    const identity = readFileSync(join(memoryDir(), "IDENTITY.md"), "utf-8");
    expect(identity).toContain("- Name: Ari");
    expect(identity).toContain("- Vibe: direct");
    expect(readFileSync(join(memoryDir(), "USER.md"), "utf-8")).toContain("- Name: Peter");
  });
});
