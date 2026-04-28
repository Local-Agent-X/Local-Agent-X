/**
 * Universal-index regression tests.
 *
 * Verifies:
 *   - per-store indexing round-trips with the right canonical source tag
 *   - daily-log incremental indexing actually adds the new lines
 *   - backfillAll is idempotent (second run adds zero chunks)
 *   - cross-source search returns results tagged with their source
 *   - dream-style file writes become searchable after a backfill pass
 *
 * Tests use a temp data dir + a fresh MemoryIndex; no embedding provider,
 * so search runs in keyword-only mode (sufficient for round-trip checks).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory.js";
import { _createUniversalIndexForTest, type UniversalIndex } from "./universal-index.js";

let tempDir: string;
let memory: MemoryIndex;
let ui: UniversalIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-uidx-"));
  // Pre-create memory subdirs so writes don't race the constructor's mkdir
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  mkdirSync(join(tempDir, "sessions"), { recursive: true });
  // BM25 rank → score saturates near 0 on tiny corpora because IDF is
  // dominated by collection-size statistics. Production has thousands of
  // chunks where the default 0.35 floor works fine; tests use a negative
  // floor so any non-zero match counts as a hit.
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  ui = _createUniversalIndexForTest(memory);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("UniversalIndex.indexEntityPage", () => {
  it("indexes an entity page and the content is searchable with source=entity", async () => {
    const slug = "bambu";
    const path = join(tempDir, "memory", "bank", "entities", `${slug}.md`);
    writeFileSync(path, "# Bambu\n\n## Facts\n\n- Lab P1S is a good 3D printer for custom glasses parts.\n", "utf-8");

    const r = await ui.indexEntityPage(slug);
    expect(r.added).toBeGreaterThan(0);

    const results = await memory.search("custom glasses parts", { sources: ["entity"], maxResults: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("entity");
    expect(results[0].snippet).toMatch(/glasses/i);
  });
});

describe("UniversalIndex.indexDailyLog (incremental)", () => {
  it("first index seeds chunks; second index after append adds new chunks but leaves overlap unchanged", async () => {
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    const path = join(tempDir, "memory", `${dateStr}.md`);

    writeFileSync(path, "# Daily Log\n\n## Morning\n\n- Started the iris-scan auth design for the bridge module.\n", "utf-8");
    const r1 = await ui.indexDailyLog(today);
    expect(r1.added).toBeGreaterThan(0);

    appendFileSync(path, "\n## Afternoon\n\n- Confirmed temple speakers passed the bone-conduction trial.\n", "utf-8");
    const r2 = await ui.indexDailyLog(today);
    expect(r2.added).toBeGreaterThan(0);
    // The morning section's content_hash didn't change, so it should not be re-added
    expect(r2.unchanged).toBeGreaterThan(0);

    const hits = await memory.search("temple speakers", { sources: ["daily-log"], maxResults: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe("daily-log");
  });
});

describe("UniversalIndex.backfillAll idempotency", () => {
  it("second run adds zero new chunks", async () => {
    // Seed one file in each store
    writeFileSync(
      join(tempDir, "memory", "bank", "entities", "alice.md"),
      "# Alice\n\n## Facts\n\n- Alice picks oat milk over almond.\n",
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "memory", "MIND.md"),
      "# Strategic Memory\n\n- The reflective coatings on AR lenses must survive iris recognition without dropping the laser pattern.\n",
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "memory", "session-summaries", "chat-test.md"),
      "# Chat Test\n\n## Key Exchanges\n\n- User: tell me about glasses\n  Agent: bridge camera, temple speakers.\n",
      "utf-8",
    );

    const r1 = await ui.backfillAll();
    expect(r1.totalChunksAdded).toBeGreaterThan(0);

    const r2 = await ui.backfillAll();
    expect(r2.totalChunksAdded).toBe(0);
    expect(r2.totalChunksUnchanged).toBeGreaterThan(0);
  });
});

describe("Cross-source search", () => {
  it("returns results tagged with the right source per store", async () => {
    writeFileSync(
      join(tempDir, "memory", "bank", "entities", "glasses.md"),
      "# Glasses\n\n## Facts\n\n- The smart glasses use waveguide optics.\n",
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "memory", "MIND.md"),
      "# MIND\n\n- Glasses project priorities: battery, thermals, weight.\n",
      "utf-8",
    );
    const today = new Date().toISOString().split("T")[0];
    writeFileSync(
      join(tempDir, "memory", `${today}.md`),
      "# Daily\n\n- Glasses prototype A passed the drop test today.\n",
      "utf-8",
    );

    await ui.backfillAll();

    const hits = await memory.search("glasses", { maxResults: 10 });
    const sources = new Set(hits.map(h => h.source));
    // Should hit at least two distinct stores
    expect(sources.size).toBeGreaterThanOrEqual(2);
    for (const h of hits) {
      expect(["entity", "mind", "daily-log", "session-summary", "session", "personality", "import"]).toContain(h.source);
    }
  });
});

describe("Dream write triggers reindex (via post-dream backfill)", () => {
  it("a fresh write to the memory dir becomes searchable after backfillAll, with the right source tag", async () => {
    // Simulate dream writing a NEW topic file via the generic write tool.
    // Dream uses the raw write tool, which doesn't go through MemoryIndex,
    // so the canonical source tag depends on backfillAll classifying the
    // file by its path.
    const topicPath = join(tempDir, "memory", "design-decisions.md");
    writeFileSync(
      topicPath,
      "# Design Decisions\n\n- Iris scanner sits in the bridge of the glasses; speakers go near the temples for bone conduction.\n",
      "utf-8",
    );

    const report = await ui.backfillAll();
    expect(report.totalChunksAdded).toBeGreaterThan(0);

    const after = await memory.search("iris scanner bridge", { maxResults: 5 });
    expect(after.length).toBeGreaterThan(0);
    // It's a non-MIND, non-daily-log file in the memory root → personality store.
    expect(after.some(r => r.source === "personality")).toBe(true);
  });
});
