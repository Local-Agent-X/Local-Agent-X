import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBuildBrief,
  renderPriorBuildBlock,
  gatherPriorBuildSessions,
  evidenceImagesFromPriorSessions,
  type PriorBuildEntry,
} from "./build-session-context.js";
import { VERIFY_EVIDENCE_MARKER } from "../canonical-loop/public/build-adapters.js";

const store = vi.hoisted(() => ({
  ops: [] as Array<Record<string, unknown>>,
  rows: {} as Record<string, Array<{ role: string; content: unknown }>>,
}));
vi.mock("../ops/op-store.js", () => ({ listOps: vi.fn(() => store.ops) }));
vi.mock("../canonical-loop/index.js", () => ({
  readOpMessages: vi.fn((opId: string) => store.rows[opId] ?? []),
  firstUserMessageText: vi.fn(() => "Instructions: a 3D maze escape game\n\nRULES: write files"),
}));

describe("extractBuildBrief", () => {
  it("pulls the Instructions line out of a seeded per-build context", () => {
    const seeded =
      "You are building a web app in the directory: /x\n" +
      "App name: maze\n\nEnvironment:\n- stuff\n\n" +
      "Instructions: a 3D maze escape game with WASD movement\n\nRULES:\n- Write ALL files";
    expect(extractBuildBrief(seeded)).toBe("a 3D maze escape game with WASD movement");
  });

  it("falls back to the raw text when the shape is unfamiliar", () => {
    expect(extractBuildBrief("just fix the timer")).toBe("just fix the timer");
  });
});

describe("renderPriorBuildBlock", () => {
  const entry = (over: Partial<PriorBuildEntry>): PriorBuildEntry => ({
    createdAt: "2026-07-06T23:31:00.000Z",
    status: "completed",
    brief: "a 3D maze escape game",
    finalReport: "APP_READY — maze built with canvas renderer",
    ...over,
  });

  it("returns null with no history — an update on a pre-feature app runs unchanged", () => {
    expect(renderPriorBuildBlock([])).toBeNull();
  });

  it("renders brief + final report and frames the build as a continuation", () => {
    const block = renderPriorBuildBlock([entry({})])!;
    expect(block).toContain("PRIOR BUILD SESSIONS");
    expect(block).toContain("CONTINUING this app");
    expect(block).toContain("[2026-07-06] brief: a 3D maze escape game");
    expect(block).toContain("builder's final report: APP_READY — maze built with canvas renderer");
    expect(block).toContain("UNVERIFIED");
  });

  it("tags a failed attempt so the fixer doesn't repeat the approach", () => {
    const block = renderPriorBuildBlock([entry({ status: "failed", finalReport: "smoke gate: page renders NOTHING" })])!;
    expect(block).toContain("BUILD FAILED — do not repeat this approach");
  });

  it("renders the verify gate's rejection as ground truth over the builder's report", () => {
    const block = renderPriorBuildBlock([entry({
      status: "failed",
      gateFailure: "vision check REJECTED the build: black screen after Start",
    })])!;
    expect(block).toContain("verify gate REJECTED that build (this is the ground truth, not the report above): vision check REJECTED the build: black screen after Start");
  });
});

describe("gate evidence — verify-adapter row → prior-build memory → next build's images (seam)", () => {
  it("reads the marker row's detail + screenshots, and attaches only screenshots still on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-evidence-"));
    const liveShot = join(dir, "smoke.png");
    writeFileSync(liveShot, "png-bytes");
    const goneShot = join(dir, "smoke-2.png"); // never written
    store.ops = [{
      id: "op_prior", type: "app_build", appUrl: "http://x/apps/maze/index.html",
      status: "failed", createdAt: "2026-07-06T23:00:00.000Z",
    }];
    store.rows = {
      op_prior: [
        { role: "assistant", content: { text: "APP_READY: http://x/apps/maze/index.html" } },
        { role: "user", content: {
          text: `${VERIFY_EVIDENCE_MARKER}\nclicking its primary action threw 3 console error(s)`,
          images: [
            { url: "", name: "smoke.png", filePath: liveShot },
            { url: "", name: "smoke-2.png", filePath: goneShot },
          ],
        } },
      ],
    };

    const entries = gatherPriorBuildSessions("http://x/apps/maze/index.html", "app_build");
    expect(entries).toHaveLength(1);
    expect(entries[0].gateFailure).toBe("clicking its primary action threw 3 console error(s)");
    expect(entries[0].evidence).toHaveLength(2);

    const images = evidenceImagesFromPriorSessions(entries);
    expect(images).toEqual([{ url: "", name: "smoke.png", filePath: liveShot }]);
  });

  it("an op with no marker row yields no gateFailure and no images", () => {
    store.ops = [{
      id: "op_clean", type: "app_build", appUrl: "http://x/apps/maze/index.html",
      status: "completed", createdAt: "2026-07-06T23:00:00.000Z",
    }];
    store.rows = { op_clean: [{ role: "assistant", content: { text: "APP_READY: done" } }] };
    const entries = gatherPriorBuildSessions("http://x/apps/maze/index.html", "app_build");
    expect(entries[0].gateFailure).toBeUndefined();
    expect(evidenceImagesFromPriorSessions(entries)).toEqual([]);
  });
});
