import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuntimeConfig, getRuntimeConfig } from "../src/config.js";
import type { LAXConfig } from "../src/types.js";

// Force the auxiliary-model call to be a no-op so tests don't depend on env
// keys or network. dispatch() returning null is the documented soft-degrade
// path — the curator should still produce a report.
vi.mock("../src/llm-dispatch.js", () => ({
  dispatch: vi.fn().mockResolvedValue(null),
  detectProvider: vi.fn().mockReturnValue(null),
}));

import { runCurator, loadCuratorState, shouldCurate } from "../src/protocols/curator.js";
import { createProtocol, saveCustomProtocols } from "../src/protocols/builder.js";
import { archiveProtocol, loadArchived } from "../src/protocols/archive.js";
import { recordUsage } from "../src/protocols/usage.js";
import type { Protocol } from "../src/protocols/types.js";

let TEMP: string;
let ORIGINAL_CFG: LAXConfig;

beforeAll(() => {
  TEMP = mkdtempSync(join(tmpdir(), "lax-curator-test-"));
  ORIGINAL_CFG = getRuntimeConfig();
  setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP } as LAXConfig);
});

beforeEach(() => {
  saveCustomProtocols([]);
  const protoDir = join(TEMP, "protocols");
  for (const f of ["archived.json", "usage.jsonl", "embeddings.json"]) {
    const p = join(protoDir, f);
    if (existsSync(p)) rmSync(p);
  }
  const curatorDir = join(protoDir, ".curator");
  if (existsSync(curatorDir)) rmSync(curatorDir, { recursive: true, force: true });
});

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CFG);
  rmSync(TEMP, { recursive: true, force: true });
});

function mkProtocol(name: string, extra: Partial<Protocol> = {}): Protocol {
  return {
    name,
    description: `${name} description`,
    triggers: [name],
    steps: [{ id: "s1", instruction: "do thing" }],
    rules: [],
    learnablePreferences: [],
    ...extra,
  };
}

/** Write fake embeddings to the cache file so cluster detection has something
 *  to work with. Vectors are tiny (5 dims) and hand-tuned so the test asserts
 *  on a known clustering outcome. */
function writeEmbeddings(entries: Record<string, number[]>): void {
  const dir = join(TEMP, "protocols");
  mkdirSync(dir, { recursive: true });
  const cache: Record<string, { vec: number[]; textHash: string }> = {};
  for (const [name, vec] of Object.entries(entries)) {
    cache[name] = { vec, textHash: "test" };
  }
  writeFileSync(join(dir, "embeddings.json"), JSON.stringify(cache), "utf-8");
}

describe("runCurator", () => {
  it("produces a report file with mechanical sections even when no LLM is available", async () => {
    createProtocol(mkProtocol("alpha"));
    const r = await runCurator();
    expect(r.reportPath).toBeTruthy();
    expect(existsSync(r.reportPath)).toBe(true);
    const md = readFileSync(r.reportPath, "utf-8");
    expect(md).toMatch(/# Protocol Curator Report/);
    expect(md).toMatch(/## Summary/);
    expect(md).toMatch(/## Lifecycle transitions/);
    expect(md).toMatch(/## Consolidation candidates/);
    expect(md).toMatch(/## Catalog gaps/);
    // LLM section indicates skipped fallback when dispatch returns null AND
    // there was content to evaluate. With no clusters and no misses, both
    // sections show "(no ...)" placeholders instead of the skipped note.
    expect(r.llmJudgments).toBeDefined();
  });

  it("updates curator state with the run timestamp + report path", async () => {
    createProtocol(mkProtocol("beta"));
    const before = loadCuratorState();
    expect(before.runs).toBe(0);

    const r = await runCurator();
    const after = loadCuratorState();
    expect(after.runs).toBe(1);
    expect(after.lastRunTs).toBe(r.ts);
    expect(after.lastReportPath).toBe(r.reportPath);
  });

  it("detects clusters of similar protocols via the embedding cache", async () => {
    createProtocol(mkProtocol("download-chatgpt-image"));
    createProtocol(mkProtocol("save-image-from-chatgpt"));
    createProtocol(mkProtocol("unrelated-stripe-checkout"));

    // Two near-identical vectors (high cosine) + one orthogonal vector.
    writeEmbeddings({
      "download-chatgpt-image": [1, 1, 0, 0, 0],
      "save-image-from-chatgpt": [1, 0.95, 0, 0, 0],
      "unrelated-stripe-checkout": [0, 0, 1, 0, 0],
    });

    const r = await runCurator();
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].members.sort()).toEqual(["download-chatgpt-image", "save-image-from-chatgpt"]);
    expect(r.clusters[0].cohesion).toBeGreaterThan(0.78);
  });

  it("surfaces recent search misses in the report", async () => {
    recordUsage({ action: "searched", name: "", query: "rename pdf files in bulk", hit: false });
    recordUsage({ action: "searched", name: "", query: "rename pdf files in bulk", hit: false });
    recordUsage({ action: "searched", name: "", query: "rename pdf files in bulk", hit: false });

    const r = await runCurator();
    expect(r.searchMisses.length).toBeGreaterThan(0);
    expect(r.searchMisses[0].query).toBe("rename pdf files in bulk");
    expect(r.searchMisses[0].count).toBe(3);
    const md = readFileSync(r.reportPath, "utf-8");
    expect(md).toMatch(/rename pdf files in bulk/);
  });

  it("applies lifecycle transitions during the pass (unless skipTransitions)", async () => {
    createProtocol(mkProtocol("stale-by-curator"));
    // Force a stale invocation 100 days ago
    const oldTs = Date.now() - 100 * 86_400_000;
    const protoDir = join(TEMP, "protocols");
    mkdirSync(protoDir, { recursive: true });
    writeFileSync(join(protoDir, "usage.jsonl"),
      JSON.stringify({ ts: oldTs, action: "invoked", name: "stale-by-curator" }) + "\n",
      "utf-8");

    const r = await runCurator({ archiveAfterDays: 30 });
    expect(r.transitions.archived.map((a) => a.name)).toContain("stale-by-curator");
    expect(loadArchived().map((rec) => rec.protocol.name)).toContain("stale-by-curator");
  });

  it("skipTransitions=true leaves the catalog untouched", async () => {
    createProtocol(mkProtocol("stale-but-skip"));
    const oldTs = Date.now() - 200 * 86_400_000;
    const protoDir = join(TEMP, "protocols");
    mkdirSync(protoDir, { recursive: true });
    writeFileSync(join(protoDir, "usage.jsonl"),
      JSON.stringify({ ts: oldTs, action: "invoked", name: "stale-but-skip" }) + "\n",
      "utf-8");

    const r = await runCurator({ skipTransitions: true, archiveAfterDays: 30 });
    expect(r.transitions.archived).toHaveLength(0);
    expect(loadArchived()).toHaveLength(0);
  });
});

describe("shouldCurate", () => {
  it("returns false when fewer than minCustomProtocols exist", () => {
    expect(shouldCurate({ minCustomProtocols: 5 })).toBe(false);
  });

  it("returns true when threshold is met and no recent run", () => {
    for (let i = 0; i < 6; i++) createProtocol(mkProtocol(`p${i}`));
    expect(shouldCurate({ minIntervalHours: 18, minCustomProtocols: 5 })).toBe(true);
  });

  it("returns false when a recent run is within minIntervalHours", async () => {
    for (let i = 0; i < 6; i++) createProtocol(mkProtocol(`p${i}`));
    await runCurator();
    expect(shouldCurate({ minIntervalHours: 24, minCustomProtocols: 5 })).toBe(false);
  });
});

describe("smoke: curator end-to-end produces actionable report", () => {
  it("creates, archives via transitions, and emits a complete report", async () => {
    // 3 live: two similar, one unique.
    createProtocol(mkProtocol("ig-caption-format"));
    createProtocol(mkProtocol("instagram-caption-formatter"));
    createProtocol(mkProtocol("stripe-refund"));
    // One stale (will be archived during the pass).
    createProtocol(mkProtocol("dead-letter"));

    writeEmbeddings({
      "ig-caption-format": [1, 1, 0, 0, 0],
      "instagram-caption-formatter": [0.98, 1, 0, 0, 0],
      "stripe-refund": [0, 0, 0, 1, 1],
      "dead-letter": [0, 1, 0, 0, 0],
    });

    const protoDir = join(TEMP, "protocols");
    mkdirSync(protoDir, { recursive: true });
    const oldTs = Date.now() - 120 * 86_400_000;
    writeFileSync(join(protoDir, "usage.jsonl"),
      JSON.stringify({ ts: oldTs, action: "invoked", name: "dead-letter" }) + "\n",
      "utf-8");

    // Search misses, too
    recordUsage({ action: "searched", name: "", query: "convert webp to jpg", hit: false });
    recordUsage({ action: "searched", name: "", query: "convert webp to jpg", hit: false });

    const r = await runCurator({ archiveAfterDays: 90 });

    // Transition: dead-letter archived
    expect(r.transitions.archived.map((a) => a.name)).toContain("dead-letter");
    // Cluster: the two IG-caption protocols
    expect(r.clusters.some((c) =>
      c.members.includes("ig-caption-format") && c.members.includes("instagram-caption-formatter")
    )).toBe(true);
    // Search miss surfaced
    expect(r.searchMisses.some((m) => m.query.includes("webp"))).toBe(true);
    // Report on disk
    expect(existsSync(r.reportPath)).toBe(true);
    const md = readFileSync(r.reportPath, "utf-8");
    expect(md).toMatch(/dead-letter/);
    expect(md).toMatch(/ig-caption-format/);
    expect(md).toMatch(/convert webp to jpg/);
  });
});
