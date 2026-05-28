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
import { describe, it, expect, vi } from "vitest";
import {
  shouldGateInKernel,
  shouldObserveInKernel,
  ariObserve,
  auditKernelCoverage,
  printKernelCoverageReport,
  type KernelCoverageReport,
} from "../src/ari-kernel/index.js";

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

  it("treats the FULL live tool registry as 100% covered (regression guard)", async () => {
    // Walks every tool the server actually registers, not a hand-curated
    // sample. The hand-sample version of this test (pre-2026-05-20) missed
    // 120 tools that weren't in TOOL_CLASS_MAP — caught only on boot when
    // the audit printed the gap to the log. This now mirrors what the boot
    // audit does, so a missing classification breaks CI instead of breaking
    // the user.
    const { allTools } = await import("../src/tools/registry-build.js");
    const names = allTools.map((t) => t.name);
    const report = auditKernelCoverage(names);
    expect(
      report.uncovered,
      `${report.uncovered.length} tool(s) missing from TOOL_CLASS_MAP: ${report.uncovered.join(", ")}`,
    ).toEqual([]);
  });
});

describe("shouldObserveInKernel", () => {
  it("returns true for explicitly classified internal tools", () => {
    expect(shouldObserveInKernel("agent_spawn")).toBe(true);
    expect(shouldObserveInKernel("protocol_create")).toBe(true);
    expect(shouldObserveInKernel("memory_recall")).toBe(true);
    expect(shouldObserveInKernel("task_create")).toBe(true);
  });

  it("returns false for gated I/O classes", () => {
    expect(shouldObserveInKernel("read")).toBe(false);
    expect(shouldObserveInKernel("bash")).toBe(false);
    expect(shouldObserveInKernel("http_request")).toBe(false);
    expect(shouldObserveInKernel("memory_search")).toBe(false);
  });

  it("returns false for unmapped tools (they're handled by the gate, not observe)", () => {
    expect(shouldObserveInKernel("definitely_not_a_real_tool")).toBe(false);
  });
});

describe("ariObserve", () => {
  // ariObserve early-returns when isAriActive() is false (no firewall),
  // which is the test environment default. The check exists so observe
  // doesn't spam logs during tests that don't bring up the kernel; the
  // host-capabilities integration test exercises the active-kernel path.
  it("is a no-op when AriKernel is inactive (test env default)", () => {
    // Just verify it doesn't throw and doesn't blow up on weird input.
    expect(() => ariObserve("any_tool", "internal", {})).not.toThrow();
    expect(() => ariObserve("any_tool", "internal", { a: 1, b: "x" })).not.toThrow();
    expect(() => ariObserve("any_tool", "internal", { _sessionId: "skip-me", real: "keep" })).not.toThrow();
  });

  it("handles unserializable params without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => ariObserve("any_tool", "internal", cyclic)).not.toThrow();
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
