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
import { resolveFact } from "./resolver.js";

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

// Live 2026-10-09 (qwen3.6:27b eval, runs 2 and 3): ~20 s after the chat,
// background extraction saved "is the user's cousin" and the 3B resolver
// answered UPDATE on the user's Merriweather story ("new cousin info"), so
// the story was gone before the next chat asked about it.
describe("a resolver's background guess cannot end what the user said", () => {
  function seed(content: string, provenance: string | null, sourceFile = "agent-tool"): number {
    authorizeTestFactMutations(memory);
    const [f] = memory.retain(`- E ${content}`, sourceFile);
    db().prepare("UPDATE facts SET provenance = ? WHERE id = ?").run(provenance, f.id!);
    return f.id!;
  }
  const liveCount = () => (db().prepare("SELECT COUNT(*) AS n FROM facts WHERE valid_to IS NULL").get() as { n: number }).n;
  const live = (id: number) => (db().prepare("SELECT valid_to FROM facts WHERE id = ?").get(id) as { valid_to: number | null }).valid_to === null;

  // A refused change saves nothing. Saving the new statement beside the old
  // (the first version of this rule) left near-duplicates — a background
  // "User's cousin Odalys keeps her sailboat … slip 14" beside the user's own —
  // and a corrected slip 14 stayed in force (qwen3.6:27b at fd10f5a4).
  it("a resolver UPDATE on a user statement ends nothing and saves nothing", async () => {
    const story = seed('In 2014 @Odalys texted the user\'s brother "did you sell Merriweather yet"', "user_statement");
    vi.mocked(resolveFact).mockResolvedValueOnce({ op: "UPDATE", targetId: story, reason: "new cousin info" });
    const { facts } = await memory.retainSmart("- W(c=0.95) @Odalys is the user's cousin", "auto-extract");
    expect(live(story)).toBe(true);
    expect(facts).toHaveLength(0);
    expect(liveCount()).toBe(1);
  });

  it("a resolver DELETE on a user statement ends nothing and saves nothing", async () => {
    const slip = seed("@Odalys keeps the Kestrel Nine at slip 14", "user_statement");
    vi.mocked(resolveFact).mockResolvedValueOnce({ op: "DELETE", targetId: slip, reason: "contradicts" });
    const { facts } = await memory.retainSmart("- W @Odalys moved the Kestrel Nine to slip 31", "auto-extract");
    expect(live(slip)).toBe(true);
    expect(facts).toHaveLength(0);
  });

  it("a user statement the agent recorded in its own words is protected too (origin assistant)", async () => {
    const paraphrase = seed("@Odalys keeps her sailboat at slip 31", "assistant", "agent-tool:auto-model-clean-user-statement");
    vi.mocked(resolveFact).mockResolvedValueOnce({ op: "UPDATE", targetId: paraphrase, reason: "duplicate" });
    await memory.retainSmart("- W @Odalys keeps the Kestrel Nine at slip 14", "auto-extract");
    expect(live(paraphrase)).toBe(true);
  });

  it("a row with no recorded origin is protected too", async () => {
    const legacy = seed("@Dana is the user's wife", null);
    vi.mocked(resolveFact).mockResolvedValueOnce({ op: "DELETE", targetId: legacy, reason: "guess" });
    await memory.retainSmart("- W @Dana likes tea", "auto-extract");
    expect(live(legacy)).toBe(true);
  });

  it("a resolver may still revise what a model wrote", async () => {
    const modelNote = seed("@user seems to like dark mode", "assistant");
    vi.mocked(resolveFact).mockResolvedValueOnce({ op: "UPDATE", targetId: modelNote, reason: "refines" });
    await memory.retainSmart("- O @user prefers dark mode in every editor", "auto-extract");
    expect(live(modelNote)).toBe(false);
  });

  it("an agent action on the user's words still ends a user statement", () => {
    const fact = seed("@Odalys keeps the Kestrel Nine at slip 14", "user_statement");
    expect(memory.invalidateFact(fact, { by: "agent", reason: "agent update_fact" })).toBe(true);
    expect(live(fact)).toBe(false);
  });
});

// qwen3:8b eval 2026-10-13: memory_search("Odalys's sailboat slip") returned 0
// hits while the fact was current — search reads entity pages, and a page was
// rebuilt only by reflect or a pattern forget, never when a fact was saved.
describe("a saved fact is searchable as soon as it is saved", () => {
  const found = async (q: string) => (await memory.search(q, { maxResults: 5, sessionId: "another-chat" }))
    .some((r) => r.snippet.includes("slip 14"));

  it("remember → search finds it; forget → search no longer does", async () => {
    authorizeTestFactMutations(memory);
    expect(memory.rememberFact("@Odalys keeps her sailboat, the Kestrel Nine, at slip 14", { kind: "world" }).ok).toBe(true);
    expect(await found("Odalys's sailboat slip")).toBe(true);
    expect(memory.forgetFact("slip 14").ok).toBe(true);
    expect(await found("Odalys's sailboat slip")).toBe(false);
  });

  it("update_fact rewrites the page: the new value is found, the old one is not", async () => {
    authorizeTestFactMutations(memory);
    memory.rememberFact("@Odalys keeps her sailboat at slip 14", { kind: "world" });
    expect(memory.updateFact("slip 14", "@Odalys keeps her sailboat at slip 31", { kind: "world" }).ok).toBe(true);
    const hits = await memory.search("Odalys sailboat slip", { maxResults: 5, sessionId: "another-chat" });
    expect(hits.some((r) => r.snippet.includes("slip 31"))).toBe(true);
    expect(hits.some((r) => r.snippet.includes("slip 14"))).toBe(false);
  });
});

describe("a fact records the user message it was saved from (schema v19)", () => {
  it("remember stores the server-stamped message id, and memory_recall shows it", async () => {
    const content = "User's cousin Odalys texted their brother did you sell Merriweather yet";
    const args: Record<string, unknown> = { content, provenance: "user_statement", _userMessageId: "um-op_x-0-2" };
    const request = describeMemoryPromotionRequest("remember", args, "default");
    stampTrustedUserPromotion(args, request!, { userMessage: content, evidenceSpan: content });
    const remember = createFactsTools(memory).find((t) => t.name === "remember")!;
    expect((await remember.execute(args)).isError).toBeFalsy();
    const row = db().prepare("SELECT source_message_id FROM facts WHERE content LIKE '%Merriweather%'").get() as { source_message_id: string };
    expect(row.source_message_id).toBe("um-op_x-0-2");
    const out = await memoryRecallTool(memory).execute({ kind: "observation" });
    expect(out.content).toContain("from message um-op_x-0-2");
  });

  it("a fact saved with no user message has none", () => {
    authorizeTestFactMutations(memory);
    const r = memory.rememberFact("@Dana likes tea", { kind: "world" });
    expect(r.fact!.sourceMessageId ?? null).toBeNull();
  });
});
