/**
 * The finishing checks (spec-probe, spec-audit, regression-audit): skipped for
 * a strong model whose own check passed after its last edit; otherwise started
 * together; and an audit's once-per-op chance is spent only when its gate uses
 * the result, so a result dropped because an earlier check re-opened the turn
 * leaves the audit to run on the next "done".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { proven: false, model: "claude-opus-5-5" };
vi.mock("../middlewares/verify-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middlewares/verify-gate.js")>()),
  opEditedSourcePaths: vi.fn(() => ["/proj/src/a.ts"]),
  opSourceCheckedSinceLastEdit: vi.fn(() => state.proven),
  opEditedSourceUnverified: vi.fn(() => false),
}));
vi.mock("../op-model.js", () => ({ resolveOpModel: vi.fn(() => state.model) }));
vi.mock("./spec-probes.js", () => ({ runSpecProbeGate: vi.fn() }));
vi.mock("./spec-audit.js", () => ({ runSpecAuditGate: vi.fn(), markSpecAudited: vi.fn() }));
vi.mock("./regression-audit.js", () => ({ runRegressionAuditGate: vi.fn(), markRegressionAudited: vi.fn() }));
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: vi.fn(() => true) }));
vi.mock("./render-verify.js", () => ({ appIdsTouchedByTurn: vi.fn(() => []), registerOpAppTouch: vi.fn(), runRenderVerifyGate: vi.fn(), turnTouchedAppFiles: vi.fn(() => false) }));
vi.mock("./build-verify.js", () => ({ runBuildVerifyGate: vi.fn() }));
vi.mock("./design-verify.js", () => ({ runDesignVerifyGate: vi.fn() }));

// Through the gate table, the way the loop loads them (the gates file alone is
// part of an import cycle that resolves only from this entry).
const { COMPLETION_GATES } = await import("./decide-outcome-gates.js");
const gate = (name: string) => COMPLETION_GATES.find((g) => g.name === name)!;
const specProbeGate = gate("spec-probe"), specAuditGate = gate("spec-audit"), regressionAuditGate = gate("regression-audit");
const probes = await import("./spec-probes.js");
const spec = await import("./spec-audit.js");
const regression = await import("./regression-audit.js");

const op = { id: "op-1" } as never;
const ctx = (turnIdx: number) => ({ op, turnIdx, toolCalls: [], assistantText: "done" });
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const clean = { nudge: "", shouldRetry: false, ran: true };

beforeEach(() => {
  vi.clearAllMocks();
  state.proven = false;
  state.model = "claude-opus-5-5";
  fn(probes.runSpecProbeGate).mockResolvedValue({ nudge: "", shouldRetry: false });
  fn(spec.runSpecAuditGate).mockResolvedValue(clean);
  fn(regression.runRegressionAuditGate).mockResolvedValue(clean);
});

async function runAll(turnIdx: number) {
  const out = [];
  for (const g of [specProbeGate, specAuditGate, regressionAuditGate]) {
    const r = await g.evaluate(ctx(turnIdx));
    out.push(r);
    if (r.reopen) break;
  }
  return out;
}

describe("skipped when a strong model already proved its work", () => {
  it("runs none of the three", async () => {
    state.proven = true;
    await runAll(0);
    expect(probes.runSpecProbeGate).not.toHaveBeenCalled();
    expect(spec.runSpecAuditGate).not.toHaveBeenCalled();
    expect(regression.runRegressionAuditGate).not.toHaveBeenCalled();
  });

  it("still runs them for a weaker model with the same proof, or a strong one without it", async () => {
    state.proven = true;
    state.model = "qwen3:8b";
    await runAll(1);
    expect(probes.runSpecProbeGate).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    fn(probes.runSpecProbeGate).mockResolvedValue({ nudge: "", shouldRetry: false });
    fn(spec.runSpecAuditGate).mockResolvedValue(clean);
    fn(regression.runRegressionAuditGate).mockResolvedValue(clean);
    state.proven = false;
    state.model = "claude-opus-5-5";
    await runAll(2);
    expect(spec.runSpecAuditGate).toHaveBeenCalledTimes(1);
  });
});

describe("run together", () => {
  it("starts all three when the first gate runs, with the audits' marks deferred", async () => {
    let releaseProbe!: (v: unknown) => void;
    fn(probes.runSpecProbeGate).mockReturnValue(new Promise((r) => { releaseProbe = r; }));
    const first = specProbeGate.evaluate(ctx(3));
    expect(spec.runSpecAuditGate).toHaveBeenCalledWith(op, expect.objectContaining({ deferMark: true }));
    expect(regression.runRegressionAuditGate).toHaveBeenCalledWith(op, expect.objectContaining({ deferMark: true }));
    releaseProbe({ nudge: "", shouldRetry: false });
    await first;
    await specAuditGate.evaluate(ctx(3));
    await regressionAuditGate.evaluate(ctx(3));
    expect(spec.runSpecAuditGate).toHaveBeenCalledTimes(1);
    expect(spec.markSpecAudited).toHaveBeenCalledWith("op-1");
    expect(regression.markRegressionAudited).toHaveBeenCalledWith("op-1");
  });

  it("an earlier check re-opening the turn spends no audit, and the next done starts them again", async () => {
    fn(probes.runSpecProbeGate).mockResolvedValueOnce({ nudge: "probe failed", shouldRetry: true });
    const first = await runAll(4);
    expect(first[0].reopen).toBe(true);
    expect(spec.markSpecAudited).not.toHaveBeenCalled();
    expect(regression.markRegressionAudited).not.toHaveBeenCalled();
    await runAll(5);
    expect(spec.runSpecAuditGate).toHaveBeenCalledTimes(2);
    expect(spec.markSpecAudited).toHaveBeenCalledTimes(1);
  });

  it("an audit that never reached the auditor is not marked spent", async () => {
    fn(spec.runSpecAuditGate).mockResolvedValue({ nudge: "", shouldRetry: false });
    await runAll(6);
    expect(spec.markSpecAudited).not.toHaveBeenCalled();
  });
});
