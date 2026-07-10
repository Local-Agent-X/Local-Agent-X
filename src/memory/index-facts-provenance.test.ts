/**
 * Fact provenance round-trip (schema v12).
 *
 * The promotion context's origin must survive the DB boundary: retain writes
 * facts.provenance, rowToFact reads it back, and memory_recall prints it
 * beside the sourceFile reference. Rows written before v12 stay NULL and the
 * recall line omits the origin tag instead of fabricating one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

vi.mock("./resolver.js", () => ({
	resolveFact: vi.fn(async (content: string) => ({ op: "ADD", reason: `new fact: ${content.slice(0, 20)}` })),
}));

import { MemoryIndex } from "../memory/index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { describeMemoryPromotionRequest, stampTrustedUserPromotion } from "./promotion-gate.js";
import { createFactsTools } from "./tools/facts.js";
import { memoryRecallTool } from "./tools/search/memory-recall.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-fact-prov-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function db(): InstanceType<typeof Database> {
  return (memory as unknown as { db: InstanceType<typeof Database> }).db;
}

function storedProvenance(id: number): string | null {
  return (db().prepare("SELECT provenance FROM facts WHERE id = ?").get(id) as { provenance: string | null }).provenance;
}

describe("fact provenance round-trip", () => {
  it("persists the promotion origin on retain and surfaces it on recall", () => {
    authorizeTestFactMutations(memory);
    const facts = memory.retain("- W @Sam: is married to the user", "daily.md");
    expect(facts).toHaveLength(1);
    // Test authorization mints an internal capability → durable_memory origin.
    expect(facts[0].provenance).toBe("durable_memory");
    expect(storedProvenance(facts[0].id!)).toBe("durable_memory");

    const recalled = memory.recallByEntity("Sam");
    expect(recalled).toHaveLength(1);
    expect(recalled[0].provenance).toBe("durable_memory");
  });

  it("persists user_statement from the remember tool and prints it in memory_recall", async () => {
    const content = "User prefers tab indentation in every codebase";
    const args: Record<string, unknown> = { content, provenance: "user_statement" };
    const request = describeMemoryPromotionRequest("remember", args, "default");
    expect(request).not.toBeNull();
    // Simulate the dispatch pipeline stamping the trusted-current-user-turn
    // capability onto the tool args before execution.
    stampTrustedUserPromotion(args, request!, { userMessage: content, evidenceSpan: content });

    const remember = createFactsTools(memory).find((t) => t.name === "remember")!;
    const saved = await remember.execute(args);
    expect(saved.isError).toBeFalsy();

    const row = db()
      .prepare("SELECT id, provenance FROM facts WHERE content LIKE '%tab indentation%'")
      .get() as { id: number; provenance: string | null };
    expect(row.provenance).toBe("user_statement");

    const recall = memoryRecallTool(memory);
    const res = await recall.execute({ kind: "observation" });
    expect(res.content).toContain("tab indentation");
    expect(res.content).toMatch(/\(agent-tool:user-statement#L\d+, origin=user_statement\)/);
  });

  it("persists the promotion origin through the retainSmart resolver path", async () => {
    authorizeTestFactMutations(memory);
    const { facts } = await memory.retainSmart("- O(c=0.9) drinks two coffees before noon", "auto-extract");
    expect(facts).toHaveLength(1);
    expect(storedProvenance(facts[0].id!)).toBe("durable_memory");
  });

  it("keeps pre-v12 rows NULL and omits the origin tag for them", async () => {
    authorizeTestFactMutations(memory);
    const facts = memory.retain("- W legacy row without recorded origin", "daily.md");
    // Simulate a row written before the provenance column existed.
    db().prepare("UPDATE facts SET provenance = NULL WHERE id = ?").run(facts[0].id!);

    const recalled = memory.recallByKind("world");
    expect(recalled).toHaveLength(1);
    expect(recalled[0].provenance).toBeNull();

    const recall = memoryRecallTool(memory);
    const res = await recall.execute({ kind: "world" });
    expect(res.content).toContain("legacy row without recorded origin");
    expect(res.content).not.toContain("origin=");
  });
});
