/**
 * Behavior tests for the post-edit-diagnostics middleware: after a turn edits
 * TS/JS source, NEW language-intel errors (vs the op's per-file baseline) are
 * injected as a same-turn nudge; pre-existing red and clean edits stay silent.
 *
 * The main flow runs against a REAL temp TS project (same fixture shape as
 * language-intel.test.ts) so the baseline/diff semantics are proven against
 * the actual compiler. The fail-open / unsupported / kill-switch cases swap
 * in a controllable intel override via the module mock below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageIntel } from "../../language-intel/index.js";
import type { CanonicalLoopContext } from "./types.js";

// Mock the language-intel facade BEFORE importing the middleware. Default
// (override null) delegates to the REAL implementation; individual tests set
// `intelOverride` to stub supports/getDiagnostics deterministically.
let intelOverride: Partial<LanguageIntel> | null = null;
vi.mock("../../language-intel/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../language-intel/index.js")>();
  return {
    ...real,
    getLanguageIntel: (): LanguageIntel => {
      const base = real.getLanguageIntel();
      return intelOverride ? { ...base, ...intelOverride } : base;
    },
  };
});

const { postEditDiagnosticsMiddleware } = await import("./post-edit-diagnostics.js");
const { _resetMiddlewareStates } = await import("./state.js");
// The spread in the mock factory keeps disposeLanguageIntel the real one.
const { disposeLanguageIntel } = await import("../../language-intel/index.js");

let _op = 0;
const opId = () => `op-ped-test-${++_op}`;

function ctxFor(op: string, over: Partial<CanonicalLoopContext>): CanonicalLoopContext {
  return {
    op: { id: op, lane: "agent" },
    turnIdx: 1,
    assistantContent: "",
    toolCalls: [],
    toolResults: [],
    toolsCalledThisOp: new Set<string>(),
    committingToolsThisOp: new Set<string>(),
    attemptedToolsThisOp: new Set<string>(),
    evidenceHistory: [],
    ...over,
  } as unknown as CanonicalLoopContext;
}

function editTurn(op: string, file: string, status: "ok" | "error" = "ok") {
  return postEditDiagnosticsMiddleware.afterToolExecution!(
    ctxFor(op, {
      toolCalls: [{ toolCallId: "e1", tool: "edit", args: { file_path: file } }],
      toolResults: [{ toolCallId: "e1", toolName: "edit", content: "ok", status }],
    } as Partial<CanonicalLoopContext>),
  );
}

// ── Fixture: tiny NodeNext ESM project (mirrors language-intel.test.ts) ──
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
  },
});

const A_TS = [
  "export function greetUser(name: string): string {",
  "  return \"hello \" + name;",
  "}",
  "",
].join("\n");

/** b.ts with a PRE-EXISTING error: greetUser(42) → TS2345. */
const B_RED_ONE = [
  'import { greetUser } from "./a.js";',
  "",
  "export const greeting = greetUser(42);",
  "",
].join("\n");

/** b.ts keeping TS2345 AND introducing a NEW error: string→number → TS2322. */
const B_RED_TWO = [
  'import { greetUser } from "./a.js";',
  "",
  "export const greeting = greetUser(42);",
  'export const n: number = "oops";',
  "",
].join("\n");

let dir: string;
let mtimeBump = 0;

/** Write + force an mtime delta so the provider's staleness check re-reads. */
function writeFixture(file: string, content: string): void {
  writeFileSync(file, content);
  mtimeBump += 5_000;
  const bumped = new Date(Date.now() + mtimeBump);
  utimesSync(file, bumped, bumped);
}

beforeEach(() => {
  _resetMiddlewareStates();
  intelOverride = null;
  // realpathSync: os.tmpdir() is a symlink on macOS; resolving keeps
  // compiler-reported paths comparable to the paths the middleware queries.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "post-edit-diag-")));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "a.ts"), A_TS);
});

afterEach(() => {
  disposeLanguageIntel(); // drops cached services + their idle timers
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LAX_POST_EDIT_DIAGNOSTICS;
});

describe("post-edit-diagnostics", () => {
  it(
    "baselines pre-existing red silently, injects only the NEW error, goes quiet once fixed",
    { timeout: 60_000 },
    async () => {
      const op = opId();
      const bPath = join(dir, "b.ts");

      // Turn 1: file is already red (TS2345) — baseline capture, no injection.
      writeFixture(bPath, B_RED_ONE);
      expect((await editTurn(op, bPath)).kind).toBe("continue");

      // Turn 2: edit introduces a NEW error (TS2322) alongside the old one.
      writeFixture(bPath, B_RED_TWO);
      const r = await editTurn(op, bPath);
      expect(r).toMatchObject({ kind: "nudge", reason: "post-edit-diagnostics" });
      if (r.kind === "nudge") {
        expect(r.message).toContain(bPath);
        expect(r.message).toContain("TS2322");
        // The pre-existing baseline error must NOT be re-reported.
        expect(r.message).not.toContain("2345");
      }

      // Turn 3: the new error is fixed (back to baseline-only red) — silence.
      writeFixture(bPath, B_RED_ONE);
      expect((await editTurn(op, bPath)).kind).toBe("continue");
    },
  );

  it("clean edit → no injection (silence, not praise)", { timeout: 60_000 }, async () => {
    const op = opId();
    const aPath = join(dir, "a.ts");
    // Turn 1 (baseline: empty) and turn 2 (still clean) both stay quiet.
    expect((await editTurn(op, aPath)).kind).toBe("continue");
    writeFixture(aPath, A_TS + "export const extra = greetUser(\"x\");\n");
    expect((await editTurn(op, aPath)).kind).toBe("continue");
  });

  it("unsupported file (.py) → no diagnostics call, no injection", async () => {
    const getDiagnostics = vi.fn<LanguageIntel["getDiagnostics"]>();
    intelOverride = { getDiagnostics }; // supports stays REAL → .py unsupported
    const py = join(dir, "script.py");
    writeFileSync(py, "def greet():\n    pass\n");
    expect((await editTurn(opId(), py)).kind).toBe("continue");
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it("failed edit dispatch → file not diagnosed", async () => {
    const getDiagnostics = vi.fn<LanguageIntel["getDiagnostics"]>();
    intelOverride = { supports: () => true, getDiagnostics };
    expect((await editTurn(opId(), join(dir, "a.ts"), "error")).kind).toBe("continue");
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it("kill switch LAX_POST_EDIT_DIAGNOSTICS=0 → inert", async () => {
    process.env.LAX_POST_EDIT_DIAGNOSTICS = "0";
    const getDiagnostics = vi.fn<LanguageIntel["getDiagnostics"]>();
    intelOverride = { supports: () => true, getDiagnostics };
    expect((await editTurn(opId(), join(dir, "a.ts"))).kind).toBe("continue");
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it("fail-open: language-intel throwing → no injection, no throw", async () => {
    intelOverride = {
      supports: () => true,
      getDiagnostics: async () => {
        throw new Error("boom");
      },
    };
    await expect(editTurn(opId(), join(dir, "a.ts"))).resolves.toMatchObject({
      kind: "continue",
    });
  });

  it("runs on ALL lanes (no `when`) — edits arrive via interactive chat too", () => {
    expect(postEditDiagnosticsMiddleware.when).toBeUndefined();
  });
});
