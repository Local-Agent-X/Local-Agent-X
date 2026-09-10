import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../ops/session-bridge.js", () => ({ getSessionForOp: vi.fn(() => undefined) }));
vi.mock("../../workspace/paths.js", () => ({ resolveAgentPath: vi.fn((p: string) => `/proj/${p}`) }));

import {
  runRegressionAuditGate,
  clearRegressionAuditStateForOp,
  _resetRegressionAuditState,
  extractChangedIdentifiers,
} from "./regression-audit.js";
import type { Op } from "../../ops/types.js";

const op = (id: string) => ({ id } as Op);
const PATHS = ["app/queries.ts"];
const DIFF = "diff --git a/queries.ts b/queries.ts\n- return jobs.filter(withinRange)\n+ return jobs";

const evidenceOk = vi.fn(async () => DIFF);
const auditWith = (verdict: string[] | null) => vi.fn(async () => verdict);
const noOverride = vi.fn(async () => null);

beforeEach(() => {
  _resetRegressionAuditState();
  vi.clearAllMocks();
});

describe("runRegressionAuditGate", () => {
  it("findings → one retry nudge naming the items", async () => {
    const audit = auditWith(["DATA EXPOSURE — mobile/page.tsx — payments field unfiltered"]);
    const r = await runRegressionAuditGate(op("a"), {
      editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride,
    });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("payments field unfiltered");
    expect(r.nudge).toContain("fresh-eyes");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("fires at most once per op — the re-claimed done is not re-audited", async () => {
    const audit = auditWith(["item"]);
    await runRegressionAuditGate(op("b"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    const second = await runRegressionAuditGate(op("b"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    expect(second.shouldRetry).toBe(false);
    expect(audit).toHaveBeenCalledOnce();
  });

  it("a clean verdict is a no-op and still consumes the op's one audit", async () => {
    const audit = auditWith([]);
    const r = await runRegressionAuditGate(op("c"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    expect(r.shouldRetry).toBe(false);
    await runRegressionAuditGate(op("c"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    expect(audit).toHaveBeenCalledOnce();
  });

  it("a null verdict (classifier down / unparseable) degrades to a no-op, never a nudge", async () => {
    const audit = auditWith(null);
    const r = await runRegressionAuditGate(op("d"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
  });

  it("no edited paths → no-op before any evidence or LLM work", async () => {
    const audit = auditWith(["item"]);
    const r = await runRegressionAuditGate(op("e"), { editedPaths: [], collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    expect(r.shouldRetry).toBe(false);
    expect(evidenceOk).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("empty/failed evidence is a no-op that does NOT consume the audit (transient git failure)", async () => {
    const audit = auditWith(["item"]);
    const empty = vi.fn(async () => "");
    const r = await runRegressionAuditGate(op("g"), { editedPaths: PATHS, collectEvidence: empty, audit, resolveProviderOverride: noOverride });
    expect(r.shouldRetry).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    const r2 = await runRegressionAuditGate(op("g"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    expect(r2.shouldRetry).toBe(true);
    const boom = vi.fn(async () => { throw new Error("git exploded"); });
    const r3 = await runRegressionAuditGate(op("h"), { editedPaths: PATHS, collectEvidence: boom, audit, resolveProviderOverride: noOverride });
    expect(r3.shouldRetry).toBe(false);
  });

  it("clearRegressionAuditStateForOp re-arms the op", async () => {
    const audit = auditWith(["item"]);
    await runRegressionAuditGate(op("i"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    clearRegressionAuditStateForOp("i");
    const r = await runRegressionAuditGate(op("i"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: noOverride });
    expect(r.shouldRetry).toBe(true);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("resolved provider override reaches the audit call", async () => {
    const audit = auditWith([]);
    const override = { provider: "anthropic", apiKey: "k", model: "claude-opus-5" };
    const resolveOverride = vi.fn(async () => override);
    await runRegressionAuditGate(op("j"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: resolveOverride });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ providerOverride: override }));
  });

  it("a throwing provider-override resolver degrades to the same-model default, never crashes the gate", async () => {
    const audit = auditWith([]);
    const resolveOverride = vi.fn(async () => { throw new Error("settings unreadable"); });
    const r = await runRegressionAuditGate(op("k"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, resolveProviderOverride: resolveOverride });
    expect(r.shouldRetry).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ providerOverride: undefined }));
  });
});

describe("extractChangedIdentifiers", () => {
  it("finds exported functions, consts, and pgTable declarations on ADDED lines only", () => {
    const diff = [
      "+export function listJobs(x) {}",
      "-export function listJobs(x, y) {}",
      "+export const jobSegments = pgTable(\"job_segments\", {})",
      "+  const notExported = 1",
    ].join("\n");
    expect(extractChangedIdentifiers(diff)).toEqual(["listJobs", "jobSegments", "job_segments"]);
  });

  it("caps at 12 identifiers", () => {
    const diff = Array.from({ length: 20 }, (_, i) => `+export function fn${i}() {}`).join("\n");
    expect(extractChangedIdentifiers(diff)).toHaveLength(12);
  });

  it("empty/no-match diff → empty list", () => {
    expect(extractChangedIdentifiers("no identifiers here")).toEqual([]);
  });
});
