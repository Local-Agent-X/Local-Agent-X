/**
 * The correction that follows a DISCREPANCIES verdict: its op shape, its
 * brief, the work root it edits under, and the one bound that keeps it from
 * correcting forever.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Op } from "../ops/types.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-verification-correct-"));
process.env.LAX_DATA_DIR = dataDir;

const h = vi.hoisted(() => ({
  target: undefined as undefined | { deliverables: string[]; parentOp: Op },
  configured: [] as Op[],
  entered: [] as Op[],
}));
vi.mock("./verification-submit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./verification-submit.js")>()),
  verificationTargetOf: () => h.target,
}));
vi.mock("./worker-op-runtime.js", () => ({
  configureWorkerOpRuntime: vi.fn(async (op: Op) => { h.configured.push(op); }),
  armWorkerOpDeadline: vi.fn(),
}));
vi.mock("./index.js", () => ({ canonicalLoopEntry: vi.fn((op: Op) => { h.entered.push(op); }) }));
vi.mock("../ops/session-bridge.js", () => ({ trackOpForSession: vi.fn() }));
vi.mock("../ops/tools/delegated-toolset.js", () => ({ delegatedToolsetForOp: () => [] }));
vi.mock("../security/index.js", () => ({
  SecurityLayer: class { addAllowedPath(): void {} },
}));
vi.mock("../security/layer/index.js", () => ({ loadFileAccessModeAtLeast: () => "workspace" }));

const {
  CORRECTION_OP_TYPE, attemptDeliverableCorrection, buildCorrectionBrief, buildCorrectionOp, commonAncestorDir, correctionContextOf,
} = await import("./verification-correct.js");

const TABLE = "VERDICT: DISCREPANCIES\n| value | deliverable says | independent source says | match? |\n|---|---|---|---|\n| Infineon share | 41% | 39% | no |\n| Navitas share | 18% | 18% | yes |";
const parent = { id: "op_parent_1", type: "freeform", task: "build the GaN market sheet" } as Op;
const DELIVERABLES = ["C:/Users/p/Scan Progress/docs/history/sheet.xlsx", "C:/Users/p/Scan Progress/docs/notes.md"];

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.target = undefined;
  h.configured.length = 0;
  h.entered.length = 0;
});

describe("commonAncestorDir", () => {
  it("is the deepest folder every deliverable sits under", () => {
    expect(commonAncestorDir(DELIVERABLES)).toBe(["C:", "Users", "p", "Scan Progress", "docs"].join(sep));
    expect(commonAncestorDir(["/w/apps/a/index.html"])).toBe(["", "w", "apps", "a"].join(sep));
  });
});

describe("buildCorrectionOp", () => {
  it("is a harness-authored build-lane op under the deliverables' folder, nested under the verified parent", async () => {
    const op = await buildCorrectionOp({ sessionId: "sess", parentOp: parent, verificationOpId: "op_verify_1", deliverables: DELIVERABLES, table: TABLE });
    expect(op.type).toBe(CORRECTION_OP_TYPE);
    expect(op.lane).toBe("build");
    expect(op.parentOpId).toBe(parent.id);
    expect(op.taskProvenance).toBe("harness");
    expect(op.contextPack.routing.workRoot).toBe(["C:", "Users", "p", "Scan Progress", "docs"].join(sep));
    expect(op.task).toBe(buildCorrectionBrief({ deliverables: DELIVERABLES, table: TABLE, parentTask: parent.task }));
  });

  it("the brief names every deliverable, carries the table, and demands the CORRECTED first line", () => {
    const brief = buildCorrectionBrief({ deliverables: DELIVERABLES, table: TABLE, parentTask: parent.task });
    for (const d of DELIVERABLES) expect(brief).toContain(`- ${d}`);
    expect(brief).toContain("| Infineon share | 41% | 39% | no |");
    expect(brief).toContain("`CORRECTED: <n> values` or `COULD NOT CORRECT: <why>`");
    expect(brief).toContain("Change nothing else");
  });
});

describe("attemptDeliverableCorrection", () => {
  const input = { verificationOpId: "op_verify_1", sessionId: "sess", verdictText: TABLE, mismatched: 1, checked: 2 };

  it("submits a correction for a pass that targeted a user task, and keeps what it was asked to fix", async () => {
    h.target = { deliverables: DELIVERABLES, parentOp: parent };
    expect(await attemptDeliverableCorrection(input)).toBe(true);
    expect(h.configured).toHaveLength(1);
    expect(h.entered).toHaveLength(1);
    const op = h.entered[0];
    expect(op.type).toBe(CORRECTION_OP_TYPE);
    expect(correctionContextOf(op.id)).toEqual({ parentTask: parent.task, deliverables: DELIVERABLES, table: TABLE, mismatched: 1, checked: 2 });
  });

  it("never corrects a correction: a second DISCREPANCIES on the re-check goes to the agent instead", async () => {
    h.target = { deliverables: DELIVERABLES, parentOp: { ...parent, id: "op_correct_1", type: CORRECTION_OP_TYPE } };
    expect(await attemptDeliverableCorrection(input)).toBe(false);
    expect(h.entered).toHaveLength(0);
  });

  it("with no recorded target (a restart since the pass was submitted) nothing is submitted", async () => {
    expect(await attemptDeliverableCorrection(input)).toBe(false);
    expect(h.entered).toHaveLength(0);
  });
});
