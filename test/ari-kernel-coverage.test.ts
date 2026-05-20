/**
 * Pins the fail-closed posture on unmapped tools (security/runtime + boot audit).
 *
 *   - shouldGateInKernel returns TRUE for unmapped names (was FALSE pre-fix).
 *     This forces unmapped tools through ariEvaluate, where they hit the
 *     new explicit-block branch instead of falling through to a defaulting
 *     accident.
 *   - Mapped tools keep their semantics: gated classes → gate, "internal" → skip.
 *   - auditKernelCoverage partitions covered vs uncovered correctly so the
 *     boot audit (server/index.ts) prints an accurate report.
 *
 * The full firewall-backed deny path is exercised indirectly here by
 * checking the gate function's return; the kernel-started integration
 * test (ari-kernel-host-capabilities.test.ts) covers the firewall side.
 */
import { describe, it, expect } from "vitest";
import {
  shouldGateInKernel,
  auditKernelCoverage,
  printKernelCoverageReport,
  type KernelCoverageReport,
} from "../src/ari-kernel.js";

describe("shouldGateInKernel", () => {
  it("returns true for gated I/O classes (file/http/shell/etc.)", () => {
    expect(shouldGateInKernel("read")).toBe(true);
    expect(shouldGateInKernel("write")).toBe(true);
    expect(shouldGateInKernel("bash")).toBe(true);
    expect(shouldGateInKernel("http_request")).toBe(true);
    expect(shouldGateInKernel("memory_search")).toBe(true);
    expect(shouldGateInKernel("browser_fill_from_secret")).toBe(true);
  });

  it("returns false for explicitly classified internal tools", () => {
    expect(shouldGateInKernel("agent_spawn")).toBe(false);
    expect(shouldGateInKernel("protocol_create")).toBe(false);
    expect(shouldGateInKernel("mission_schedule_create")).toBe(false);
    expect(shouldGateInKernel("ari_file")).toBe(false);
  });

  it("returns TRUE for unmapped tools (fail-closed posture)", () => {
    // Whatever name we pick will be a moving target as the codebase grows,
    // so use a clearly-not-real name. The contract is: "missing from
    // TOOL_CLASS_MAP" → gate kicks in → ariEvaluate's unmapped branch fires.
    expect(shouldGateInKernel("definitely_not_a_real_tool_name_xyz")).toBe(true);
    expect(shouldGateInKernel("zzz_unmapped_tool")).toBe(true);
  });
});

describe("auditKernelCoverage", () => {
  it("returns empty uncovered for an empty input", () => {
    const report = auditKernelCoverage([]);
    expect(report).toEqual({ totalTools: 0, covered: [], uncovered: [] });
  });

  it("classifies covered vs uncovered correctly", () => {
    const report = auditKernelCoverage([
      "read",                       // covered (file)
      "agent_spawn",                // covered (internal)
      "protocol_curate",            // covered (internal — added 2026-05-20)
      "definitely_not_a_real_tool", // uncovered
      "another_ghost_tool",         // uncovered
    ]);
    expect(report.totalTools).toBe(5);
    expect(report.covered.sort()).toEqual(["agent_spawn", "protocol_curate", "read"]);
    expect(report.uncovered.sort()).toEqual(["another_ghost_tool", "definitely_not_a_real_tool"]);
  });

  it("treats the production catalog as 100% covered (regression guard)", () => {
    // Sample of high-traffic production tools that MUST stay classified.
    // If any of these falls out of TOOL_CLASS_MAP we want a red test, not
    // a runtime fail-closed surprise on a user's chat.
    const productionTools = [
      "read", "write", "edit", "bash", "browser", "http_request",
      "web_search", "web_fetch", "memory_search", "memory_save",
      "agent_spawn", "agent_status", "agent_cancel",
      "protocol_list", "protocol_get", "protocol_create", "protocol_delete",
      "protocol_curate", "protocol_stats",
      "mission_schedule_create", "mission_schedule_list",
      "browser_capture_to_secret", "browser_fill_from_secret",
      "generate_image", "screen_capture", "ocr",
    ];
    const report = auditKernelCoverage(productionTools);
    expect(report.uncovered).toEqual([]);
  });
});

describe("printKernelCoverageReport", () => {
  // Smoke only — the function is a log emitter. Goal is "doesn't throw on
  // either branch" and "doesn't accidentally log success when uncovered > 0".
  it("doesn't throw on a fully-covered report", () => {
    const report: KernelCoverageReport = { totalTools: 3, covered: ["a", "b", "c"], uncovered: [] };
    expect(() => printKernelCoverageReport(report)).not.toThrow();
  });

  it("doesn't throw on an uncovered report", () => {
    const report: KernelCoverageReport = { totalTools: 5, covered: ["a", "b"], uncovered: ["x", "y", "z"] };
    expect(() => printKernelCoverageReport(report)).not.toThrow();
  });
});
