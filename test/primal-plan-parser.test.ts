/**
 * Plan parser tests — exercise against synthetic plans + the real
 * Calenbella spec/plan.md (when present on this dev box). The Calenbella
 * test is gated on file existence so CI on a fresh checkout still passes.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import {
  parsePlanText,
  parsePlanFile,
  classifyChunkText,
} from "../src/primal-auto-build/plan-parser.js";

describe("classifyChunkText", () => {
  it("returns trunk on a pure-trunk line", () => {
    expect(classifyChunkText("trunk → `/senior-engineer`")).toBe("trunk");
  });
  it("returns leaf on a pure-leaf line", () => {
    expect(classifyChunkText("leaf → `/vibe-code`")).toBe("leaf");
  });
  it("returns mixed when the word 'mixed' appears anywhere", () => {
    expect(classifyChunkText("mixed: data layer is trunk, UI is leaf")).toBe("mixed");
  });
  it("returns mixed when both trunk and leaf appear without 'mixed'", () => {
    expect(classifyChunkText("trunk piece + leaf piece")).toBe("mixed");
  });
  it("returns mixed on garbage / empty input", () => {
    expect(classifyChunkText("")).toBe("mixed");
    expect(classifyChunkText("???")).toBe("mixed");
  });
});

describe("parsePlanText — minimal synthetic plan", () => {
  const sample = [
    "# Sample plan",
    "",
    "## Phase A — Foundation",
    "",
    "### Chunk 1 — Project skeleton",
    "- **Class:** trunk → `/senior-engineer`",
    "- **Slice:** repo init, ts strict.",
    "- **Depends on:** —",
    "- **Scenarios:** —",
    "- **Done when:** `pnpm dev` boots a hello page.",
    "",
    "### Chunk 2 — DB schema",
    "- **Class:** trunk → `/senior-engineer`",
    "- **Slice:** drizzle schema.",
    "- **Depends on:** 1",
    "- **Scenarios:** —",
    "- **Done when:**",
    "  - migration runs locally",
    "  - integration test asserts isolation",
    "",
    "## Phase B — UI",
    "",
    "### Chunk 3 — Public page",
    "- **Class:** leaf → `/vibe-code`",
    "- **Slice:** static page.",
    "- **Depends on:** 1, 2",
    "- **Scenarios:** 1, 2",
    "- **Done when:** page renders.",
    "",
    "## Phase verification gates",
    "",
    "After Chunk 3, drive scenario 1 at http://localhost:3000.",
    "",
    "## Launch readiness — deferred verification items",
    "",
    "| Item | From chunk | Why deferred | How to verify before launch |",
    "|---|---|---|---|",
    "| Apple Sign In e2e | 4 | needs HTTPS | stand up staging |",
    "",
  ].join("\n");

  it("parses title and phases", () => {
    const plan = parsePlanText(sample);
    expect(plan.title).toBe("Sample plan");
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[0].phase).toBe("Phase A — Foundation");
    expect(plan.chunks[2].phase).toBe("Phase B — UI");
  });

  it("extracts class per chunk", () => {
    const plan = parsePlanText(sample);
    expect(plan.chunks[0].klass).toBe("trunk");
    expect(plan.chunks[1].klass).toBe("trunk");
    expect(plan.chunks[2].klass).toBe("leaf");
  });

  it("parses dependsOn as numeric arrays", () => {
    const plan = parsePlanText(sample);
    expect(plan.chunks[0].dependsOn).toEqual([]);
    expect(plan.chunks[1].dependsOn).toEqual([1]);
    expect(plan.chunks[2].dependsOn).toEqual([1, 2]);
  });

  it("captures multi-line done-when including sub-bullets", () => {
    const plan = parsePlanText(sample);
    expect(plan.chunks[1].doneWhen).toContain("migration runs locally");
    expect(plan.chunks[1].doneWhen).toContain("integration test asserts isolation");
  });

  it("extracts phase verification gates raw section", () => {
    const plan = parsePlanText(sample);
    expect(plan.phaseGatesRawSection).toContain("Phase verification gates");
    expect(plan.phaseGatesRawSection).toContain("scenario 1");
  });

  it("extracts launch readiness table rows", () => {
    const plan = parsePlanText(sample);
    expect(plan.launchReadinessRows).toHaveLength(1);
    expect(plan.launchReadinessRows[0].item).toBe("Apple Sign In e2e");
    expect(plan.launchReadinessRows[0].fromChunk).toBe("4");
    expect(plan.launchReadinessRows[0].howToVerify).toContain("staging");
  });

  it("throws on a plan with no chunks", () => {
    expect(() => parsePlanText("# Empty\n\n## Phase A\n\nNothing here.")).toThrow(/no chunks/);
  });
});

describe("parsePlanText — mixed-class chunk", () => {
  const mixedSample = [
    "# Mixed plan",
    "",
    "## Phase C",
    "",
    "### Chunk 10 — Event types CRUD",
    "- **Class:** mixed: data layer is trunk, UI is leaf",
    "- **Slice:** server actions, dashboard UI.",
    "- **Depends on:** 2, 3",
    "- **Scenarios:** 1",
    "- **Done when:** create + edit work, slug uniqueness enforced.",
  ].join("\n");

  it("detects mixed class from a free-form Class: line", () => {
    const plan = parsePlanText(mixedSample);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].klass).toBe("mixed");
    expect(plan.chunks[0].number).toBe(10);
  });
});

describe("parsePlanFile — real Calenbella plan (dev-box smoke)", () => {
  const CALENBELLA_PLAN = "c:/Users/manri/Calenbella/spec/plan.md";
  const skip = !existsSync(CALENBELLA_PLAN);

  it.skipIf(skip)("parses 31 chunks across phases A–K", () => {
    const plan = parsePlanFile(CALENBELLA_PLAN);
    expect(plan.chunks.length).toBeGreaterThanOrEqual(25);
    // Verify chunk numbers are unique and start at 1.
    const numbers = plan.chunks.map(c => c.number);
    expect(numbers[0]).toBe(1);
    expect(new Set(numbers).size).toBe(numbers.length);
    // Phase mix sanity check.
    const phases = new Set(plan.chunks.map(c => c.phase));
    expect(phases.size).toBeGreaterThan(3);
  });

  it.skipIf(skip)("detects chunk 6 (Google adapter) as trunk", () => {
    const plan = parsePlanFile(CALENBELLA_PLAN);
    const c6 = plan.chunks.find(c => c.number === 6);
    expect(c6).toBeDefined();
    expect(c6!.klass).toBe("trunk");
    expect(c6!.title.toLowerCase()).toContain("google");
  });

  it.skipIf(skip)("detects chunk 10 (Event types CRUD) as mixed", () => {
    const plan = parsePlanFile(CALENBELLA_PLAN);
    const c10 = plan.chunks.find(c => c.number === 10);
    expect(c10).toBeDefined();
    expect(c10!.klass).toBe("mixed");
  });

  it.skipIf(skip)("detects chunk 12 (Public booking page UI) as leaf", () => {
    const plan = parsePlanFile(CALENBELLA_PLAN);
    const c12 = plan.chunks.find(c => c.number === 12);
    expect(c12).toBeDefined();
    expect(c12!.klass).toBe("leaf");
  });

  it.skipIf(skip)("captures chunk-7 multi-line done-when fully", () => {
    const plan = parsePlanFile(CALENBELLA_PLAN);
    const c7 = plan.chunks.find(c => c.number === 7);
    expect(c7).toBeDefined();
    expect(c7!.doneWhen).toContain("Adapter unit tests");
    expect(c7!.doneWhen).toContain("401-detection");
    expect(c7!.doneWhen).toContain("scenario-1 + scenario-4 satisfaction");
  });

  it.skipIf(skip)("extracts launch-readiness rows", () => {
    const plan = parsePlanFile(CALENBELLA_PLAN);
    expect(plan.launchReadinessRows.length).toBeGreaterThanOrEqual(2);
    const apple = plan.launchReadinessRows.find(r => r.item.toLowerCase().includes("apple"));
    expect(apple).toBeDefined();
    expect(apple!.howToVerify.toLowerCase()).toContain("staging");
  });

  it.skipIf(skip)("phase-verification-gates section is non-empty", () => {
    const plan = parsePlanFile(CALENBELLA_PLAN);
    expect(plan.phaseGatesRawSection).toContain("Phase verification gates");
    expect(plan.phaseGatesRawSection.length).toBeGreaterThan(200);
  });
});
