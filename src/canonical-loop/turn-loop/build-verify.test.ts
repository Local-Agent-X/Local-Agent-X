import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setSessionWorkRoot, clearSessionWorkRoot } from "../../workspace/paths.js";
import { uploadsDir } from "../../config.js";

// The gate writes its verdict into the verify-gate ledger and reads edited
// paths from it. Mock that seam so the test isolates the gate's own control
// flow (detect → run → record → retry/cap) without standing up middleware state.
vi.mock("../middlewares/verify-gate.js", () => ({
  opEditedSourcePaths: vi.fn(() => [] as string[]),
  recordOrchestratorVerify: vi.fn(),
}));

// Same isolation for the LSP fail-fast seam: the default (no outstanding
// introduced errors) makes every pre-existing test below double as the
// regression pin that the normal build path is unchanged when the language
// service has nothing outstanding.
vi.mock("../middlewares/post-edit-diagnostics.js", () => ({
  opOutstandingIntroducedErrors: vi.fn(async () => [] as import("../../language-intel/index.js").FileDiagnostic[]),
}));

import {
  runBuildVerifyGate,
  getBuildVerifyRetries,
  _resetBuildVerifyState,
  clearBuildVerifyStateForOp,
  groundTruthSizesNote,
} from "./build-verify.js";
import { recordOrchestratorVerify, opEditedSourcePaths } from "../middlewares/verify-gate.js";
import { opOutstandingIntroducedErrors } from "../middlewares/post-edit-diagnostics.js";
import type { FileDiagnostic } from "../../language-intel/index.js";
import type { FsProbe } from "../../agent-guards/index.js";
import type { Op } from "../../ops/types.js";

const op = { id: "op-bv" } as unknown as Op;

// Edited paths go through the canonical resolver UNCONDITIONALLY, and resolve()
// drive-prefixes a POSIX-absolute fixture path on win32. So the fixture project
// is spelled through the same resolve() the gate applies, and probes compare
// normalized — the tests then describe the same tree on either host.
const PROJ = resolve("/proj");
const nrm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const at = (rel: string) => nrm(resolve(PROJ, rel));

// A probe describing one buildable TS project at /proj (typecheck script).
const probe: FsProbe = {
  exists: (p) => nrm(p) === at("package.json"),
  readJson: (p) => (nrm(p) === at("package.json") ? { scripts: { typecheck: "tsc --noEmit" } } : null),
};

const RED = async () => ({ ok: false, output: "src/a.ts(3,5): error TS2339: Property 'x' does not exist." });
const GREEN = async () => ({ ok: true, output: "" });

// A project at /proj with a typecheck script AND a local vitest binary — so a
// test file edit triggers the edited-test pass on top of the type-check.
const probeWithVitest: FsProbe = {
  exists: (p) => nrm(p) === at("package.json") || nrm(p) === at("node_modules/.bin/vitest"),
  readJson: (p) => (nrm(p) === at("package.json") ? { scripts: { typecheck: "tsc --noEmit" } } : null),
};

// An exec that answers by command: the vitest run vs the type-check.
const byCommand = (typecheckOk: boolean, testOk: boolean) =>
  vi.fn(async (command: string) =>
    command.includes("vitest")
      ? { ok: testOk, output: testOk ? "" : "FAIL foo.test.ts > keeps user msg — expected 6 got 5" }
      : { ok: typecheckOk, output: typecheckOk ? "" : "src/a.ts(3,5): error TS2339" },
  );

describe("runBuildVerifyGate", () => {
  beforeEach(() => {
    _resetBuildVerifyState();
    vi.clearAllMocks();
  });

  it("on a RED build: injects errors, asks to retry, records the verdict as failed", async () => {
    const exec = vi.fn(RED);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(exec).toHaveBeenCalledWith("npm run typecheck", PROJ);
    expect(r.shouldRetry).toBe(true);
    expect(r.capReached).toBe(false);
    expect(r.nudge).toContain("npm run typecheck");
    expect(r.nudge).toContain("TS2339");
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", false);
    expect(getBuildVerifyRetries("op-bv")).toBe(1);
    // A red build is never rounded up to a clean confirmation.
    expect(r.verifiedClean).toBe(false);
    expect(r.confirmation).toBe("");
  });

  it("on a GREEN build: lets done stand, records passed, and confirms clean for the record", async () => {
    const exec = vi.fn(GREEN);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", true);
    expect(getBuildVerifyRetries("op-bv")).toBe(0);
    // Reconcile-on-green: a real pass surfaces a positive confirmation so a
    // model that couldn't self-verify doesn't leave "unverified" as the last word.
    expect(r.verifiedClean).toBe(true);
    expect(r.confirmation).toContain("Verified");
    expect(r.confirmation).toContain("npm run typecheck");
  });

  it("green build's confirmation stays size-free (sizes are a separate op-end note)", async () => {
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec: vi.fn(GREEN) });
    expect(r.verifiedClean).toBe(true);
    expect(r.confirmation).not.toContain("Ground-truth size");
  });

  it("caps the fix loop: past MAX_RETRIES it stops retrying but still reports red", async () => {
    const exec = vi.fn(RED);
    const run = () => runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect((await run()).shouldRetry).toBe(true); // retry 1
    expect((await run()).shouldRetry).toBe(true); // retry 2
    const third = await run();                    // cap
    expect(third.shouldRetry).toBe(false);
    expect(third.capReached).toBe(true);
    expect(third.nudge).toContain("TS2339"); // errors still surfaced, just not looped on
  });

  it("no buildable project found: never runs anything, never records a verdict", async () => {
    const empty: FsProbe = { exists: () => false, readJson: () => null };
    const exec = vi.fn(RED);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/nowhere/a.ts"], probe: empty, exec });
    expect(r.shouldRetry).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(recordOrchestratorVerify).not.toHaveBeenCalled();
    // "no buildable project" is NOT a clean verify — it must not confirm.
    expect(r.verifiedClean).toBe(false);
    expect(r.confirmation).toBe("");
  });

  it("no edited paths: no-op", async () => {
    const exec = vi.fn(RED);
    const r = await runBuildVerifyGate(op, { editedPaths: [], probe, exec });
    expect(r.shouldRetry).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("edited test that FAILS: type-check passes but the test is red → nudge + retry, records partial", async () => {
    const exec = byCommand(true, false);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec });
    expect(exec).toHaveBeenCalledWith("npm run typecheck", PROJ);
    expect(exec).toHaveBeenCalledWith("node_modules/.bin/vitest run src/foo.test.ts", PROJ);
    expect(r.shouldRetry).toBe(true);
    expect(r.verifiedClean).toBe(false);
    expect(r.nudge).toMatch(/test you touched is FAILING/i);
    expect(r.nudge).toContain("vitest run src/foo.test.ts");
    // A type-clean-but-test-red edit records partial, not clean.
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", false);
  });

  it("edited test that PASSES: type-check + test both green → verifiedClean, confirmation names both", async () => {
    const exec = byCommand(true, true);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec });
    expect(r.verifiedClean).toBe(true);
    expect(r.confirmation).toContain("npm run typecheck");
    expect(r.confirmation).toContain("vitest run src/foo.test.ts");
    expect(recordOrchestratorVerify).toHaveBeenLastCalledWith("op-bv", true);
  });

  it("edited test but type-check FAILS: stops at the type-check, never runs the test", async () => {
    const exec = byCommand(false, true);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("TS2339");
    expect(exec).toHaveBeenCalledTimes(1); // type-check only; test pass skipped while red
    expect(exec).not.toHaveBeenCalledWith("node_modules/.bin/vitest run src/foo.test.ts", PROJ);
  });
});

// LSP fail-fast: when post-edit diagnostics already know the op INTRODUCED
// type errors it never resolved, the gate fails with THAT list instead of
// spawning the build — cheap strong negative first. lsp-clean has no inverse
// power: it never skips or weakens the build (pinned by the default-[] mock
// leaving every other test's build path untouched).
describe("runBuildVerifyGate — outstanding introduced type errors (LSP fail-fast)", () => {
  const OUTSTANDING: FileDiagnostic[] = [
    { file: "/proj/src/a.ts", line: 3, column: 5, message: "Type 'string' is not assignable to type 'number'.", code: 2322, severity: "error" },
  ];

  beforeEach(() => {
    _resetBuildVerifyState();
    vi.clearAllMocks();
  });

  it("fails fast with the diagnostics as evidence — build NOT spawned, verdict recorded red", async () => {
    vi.mocked(opOutstandingIntroducedErrors).mockResolvedValueOnce(OUTSTANDING);
    const exec = vi.fn(GREEN); // even a would-be-green build must not run
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(exec).not.toHaveBeenCalled();
    expect(r.shouldRetry).toBe(true);
    expect(r.capReached).toBe(false);
    expect(r.verifiedClean).toBe(false);
    expect(r.nudge).toContain("INTRODUCED type errors");
    expect(r.nudge).toContain("/proj/src/a.ts:3:5");
    expect(r.nudge).toContain("TS2322");
    expect(r.nudge).toContain("not assignable");
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", false);
    expect(getBuildVerifyRetries("op-bv")).toBe(1);
  });

  it("shares the retry cap with the build path — past MAX_RETRIES it stops looping", async () => {
    vi.mocked(opOutstandingIntroducedErrors).mockResolvedValue(OUTSTANDING);
    const exec = vi.fn(GREEN);
    const run = () => runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect((await run()).shouldRetry).toBe(true);  // retry 1
    expect((await run()).shouldRetry).toBe(true);  // retry 2
    const third = await run();                     // cap
    expect(third.shouldRetry).toBe(false);
    expect(third.capReached).toBe(true);
    expect(third.nudge).toContain("TS2322"); // errors still surfaced
    expect(exec).not.toHaveBeenCalled();
    vi.mocked(opOutstandingIntroducedErrors).mockResolvedValue([]);
  });

  it("fires even when no buildable project is detectable — the evidence needs no manifest", async () => {
    vi.mocked(opOutstandingIntroducedErrors).mockResolvedValueOnce(OUTSTANDING);
    const empty: FsProbe = { exists: () => false, readJson: () => null };
    const r = await runBuildVerifyGate(op, { editedPaths: ["/nowhere/a.ts"], probe: empty, exec: vi.fn(GREEN) });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("TS2322");
  });

  it("no outstanding errors → the build path is invoked exactly as before", async () => {
    vi.mocked(opOutstandingIntroducedErrors).mockResolvedValueOnce([]);
    const exec = vi.fn(GREEN);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(exec).toHaveBeenCalledWith("npm run typecheck", PROJ);
    expect(r.verifiedClean).toBe(true);
    expect(recordOrchestratorVerify).toHaveBeenCalledWith("op-bv", true);
  });

  it("stale-then-pruned: once the re-verifying accessor prunes the phantom entry, the gate proceeds to the normal build path", async () => {
    // First call: the entry still reproduces → fail-fast red.
    vi.mocked(opOutstandingIntroducedErrors).mockResolvedValueOnce(OUTSTANDING);
    // Second call: the error was fixed indirectly; the accessor's re-verify
    // pruned it → the gate must NOT phantom-red and instead run the build.
    vi.mocked(opOutstandingIntroducedErrors).mockResolvedValueOnce([]);
    const exec = vi.fn(GREEN);
    const first = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(first.shouldRetry).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    const second = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec });
    expect(exec).toHaveBeenCalledWith("npm run typecheck", PROJ);
    expect(second.shouldRetry).toBe(false);
    expect(second.verifiedClean).toBe(true);
    expect(recordOrchestratorVerify).toHaveBeenLastCalledWith("op-bv", true);
  });
});

// Pick 2: retry-with-reframe. On the 2nd+ red build the nudge names which errors
// the last edit FIXED vs which SURVIVED unchanged vs which are NEW — deterministic
// error-signature diff, zero LLM calls. A weak model that gets the same dump twice
// gives up or thrashes; telling it the same error survived redirects the fix.
describe("runBuildVerifyGate — retry reframe (error-diff nudge)", () => {
  beforeEach(() => { _resetBuildVerifyState(); vi.clearAllMocks(); });

  // Distinct line numbers on purpose — normalization strips (row,col), so the
  // SAME logical error compares equal across retries even as lines shift.
  const R_ABC = "src/a.ts(3,5): error TS2339: Property 'x' does not exist.\nsrc/b.ts(7,9): error TS2551: Did you mean 'y'?\nsrc/c.ts(1,1): error TS1005: ';' expected.";
  const R_ABC_shifted = "src/a.ts(9,5): error TS2339: Property 'x' does not exist.\nsrc/b.ts(2,9): error TS2551: Did you mean 'y'?\nsrc/c.ts(4,4): error TS1005: ';' expected.";
  const R_AB_shifted = "src/a.ts(9,5): error TS2339: Property 'x' does not exist.\nsrc/b.ts(2,9): error TS2551: Did you mean 'y'?";
  const R_A_plus_D = "src/a.ts(9,5): error TS2339: Property 'x' does not exist.\nsrc/d.ts(2,2): error TS2304: Cannot find name 'z'.";
  const redWith = (output: string) => vi.fn(async () => ({ ok: false, output }));
  const run = (exec: () => Promise<{ ok: boolean; output: string }>) =>
    runBuildVerifyGate(op, { editedPaths: ["/proj/src/a.ts"], probe, exec: vi.fn(exec) });

  it("FIRST red carries NO reframe — identical to today's nudge", async () => {
    const r = await run(async () => ({ ok: false, output: R_ABC }));
    expect(r.nudge).toContain("TS2339");        // full error block present
    expect(r.nudge).not.toMatch(/PROGRESS|SURVIVED|still failing/);
  });

  it("SECOND red, same errors survive → NO PROGRESS reframe", async () => {
    await run(async () => ({ ok: false, output: R_ABC }));
    const r2 = await run(async () => ({ ok: false, output: R_ABC_shifted }));
    expect(r2.nudge).toContain("NO PROGRESS");
    expect(r2.nudge).toMatch(/fixed NONE/i);
    expect(r2.nudge).toContain("still failing:");
    expect(r2.nudge).toContain("TS2339");        // real block still below the reframe
  });

  it("SECOND red, some fixed + some survive → PROGRESS reframe with counts", async () => {
    await run(async () => ({ ok: false, output: R_ABC }));
    const r2 = await run(async () => ({ ok: false, output: R_AB_shifted }));
    expect(r2.nudge).toContain("PROGRESS since your last edit");
    expect(r2.nudge).toContain("fixed 1");
    expect(r2.nudge).toContain("2 SURVIVED");
  });

  it("SECOND red with a brand-new error → flags the regression", async () => {
    await run(async () => ({ ok: false, output: R_ABC }));
    const r2 = await run(async () => ({ ok: false, output: R_A_plus_D }));
    expect(r2.nudge).toMatch(/NEW error\(s\) appeared/);
    expect(r2.nudge).toContain("TS2304");        // the new one, named
  });

  it("degrades to no reframe when output has no parseable error lines", async () => {
    await run(async () => ({ ok: false, output: "" }));
    const r2 = await run(async () => ({ ok: false, output: "" }));
    expect(r2.nudge).not.toMatch(/PROGRESS|NO PROGRESS/);
  });

  it("clearBuildVerifyStateForOp wipes the snapshot — next red is treated as first", async () => {
    await run(async () => ({ ok: false, output: R_ABC }));
    clearBuildVerifyStateForOp("op-bv");
    const r2 = await run(async () => ({ ok: false, output: R_ABC_shifted }));
    expect(r2.nudge).not.toMatch(/PROGRESS|NO PROGRESS/);
    expect(getBuildVerifyRetries("op-bv")).toBe(1); // counter also reset → back to first retry
  });

  it("channel switch (build-red → test-red) does NOT diff across kinds", async () => {
    // build red first (channel=build), then build green + edited-test red (channel=test).
    await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec: byCommand(false, false) });
    const r2 = await runBuildVerifyGate(op, { editedPaths: ["/proj/src/foo.test.ts"], probe: probeWithVitest, exec: byCommand(true, false) });
    expect(r2.nudge).toMatch(/test you touched is FAILING/i);
    expect(r2.nudge).not.toMatch(/PROGRESS|NO PROGRESS/); // no cross-channel diff
  });
});

// Relative edited paths must resolve where the agent actually WROTE them — via
// the canonical resolver, with the op's session. A worker anchored on a project
// outside the data root registers a session work root; anchoring on the project
// root instead pointed at a path that does not exist, and the project walk-up
// then latched onto whatever unrelated manifest sat above it.
describe("runBuildVerifyGate — relative edited-path resolution", () => {
  beforeEach(() => { _resetBuildVerifyState(); vi.clearAllMocks(); });

  it("anchors a relative edited path on the session work root, not the project root", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bv-root-")));
    setSessionWorkRoot("sess-bv", dir);
    try {
      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const root = norm(dir);
      // Only the work root is a project; nothing above it is.
      const workRootProbe: FsProbe = {
        exists: (p) => norm(p) === `${root}/package.json`,
        readJson: (p) => (norm(p) === `${root}/package.json` ? { scripts: { typecheck: "tsc --noEmit" } } : null),
      };
      const exec = vi.fn(GREEN);
      const sessionOp = { id: "op-bv", sessionId: "sess-bv" } as unknown as Op;
      const r = await runBuildVerifyGate(sessionOp, { editedPaths: ["src/a.ts"], probe: workRootProbe, exec });
      expect(exec).toHaveBeenCalledWith("npm run typecheck", dir);
      expect(r.verifiedClean).toBe(true);
    } finally {
      clearSessionWorkRoot("sess-bv");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The PLATFORM-INDEPENDENT pin on the resolver being called UNCONDITIONALLY.
  // resolveAgentPathFrom rewrites two absolute-LOOKING spellings before it ever
  // reaches its own isAbsolute check (workspace/paths.ts): "/uploads/<file>",
  // on every platform, and MSYS "/c/Users/…", on win32 only. An `isAbsolute(p) ?
  // p : …` short-circuit ahead of it skips both, yielding a path that exists
  // nowhere on disk ⇒ no manifest ⇒ the op is silently never verified. The MSYS
  // case below can only be exercised on Windows, so this one carries the pin on
  // Linux/macOS CI — restoring the short-circuit must fail on ANY host.
  it("routes an absolute-looking /uploads ref through the canonical resolver", async () => {
    const uploads = uploadsDir();
    const uploadsProbe: FsProbe = {
      exists: (p) => nrm(p) === `${nrm(uploads)}/package.json`,
      readJson: (p) => (nrm(p) === `${nrm(uploads)}/package.json` ? { scripts: { typecheck: "tsc --noEmit" } } : null),
    };
    const exec = vi.fn(GREEN);
    const r = await runBuildVerifyGate(op, { editedPaths: ["/uploads/a.ts"], probe: uploadsProbe, exec });
    expect(exec).toHaveBeenCalledWith("npm run typecheck", uploads);
    expect(r.verifiedClean).toBe(true);
  });

  // isAbsolute("/c/Users/…") is TRUE on win32, so the short-circuit above let
  // MSYS-spelled paths skip the resolver too — the spelling this box's own Git
  // Bash actually emits, which is why it gets its own case.
  it("routes an MSYS-spelled absolute path through the canonical resolver", async (ctx) => {
    if (process.platform !== "win32") ctx.skip("MSYS drive spelling is a win32-only hazard");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bv-msys-")));
    try {
      const msys = `/${dir[0].toLowerCase()}${dir.slice(2).replace(/\\/g, "/")}`;
      const msysProbe: FsProbe = {
        exists: (p) => nrm(p) === `${nrm(dir)}/package.json`,
        readJson: (p) => (nrm(p) === `${nrm(dir)}/package.json` ? { scripts: { typecheck: "tsc --noEmit" } } : null),
      };
      const exec = vi.fn(GREEN);
      const r = await runBuildVerifyGate(op, { editedPaths: [`${msys}/src/a.ts`], probe: msysProbe, exec });
      expect(exec).toHaveBeenCalledWith("npm run typecheck", dir);
      expect(r.verifiedClean).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("groundTruthSizesNote — real file sizes when the model quotes one", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the wc -l line count of edited files when the reply quotes a size", () => {
    // 137 newlines → `wc -l` == 137; a reply claiming any other number (e.g. 294)
    // is contradicted by this authoritative note.
    const dir = mkdtempSync(join(tmpdir(), "bv-size-"));
    try {
      const file = join(dir, "big.ts");
      writeFileSync(file, "const x = 1;\n".repeat(137));
      vi.mocked(opEditedSourcePaths).mockReturnValueOnce([file]);
      const note = groundTruthSizesNote("op-bv", "Done — big.ts is now 294 lines, clean split.", undefined);
      expect(note).not.toBeNull();
      expect(note).toContain("137 lines");
      expect(note).toContain("wc -l");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The note resolves relative edited paths itself. Without the op's SESSION
  // work root it fell back to the project root — a location that doesn't exist
  // for a worker anchored elsewhere — readFileSync threw, and the whole
  // authoritative note was silently dropped.
  // (Ordered before the quotes-NO-size case below on purpose: that one returns
  // early without ever calling the mock, leaving its mockReturnValueOnce queued
  // for whichever test calls next.)
  it("resolves a relative edited path through the op's session work root", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bv-sess-size-")));
    setSessionWorkRoot("sess-size", dir);
    try {
      writeFileSync(join(dir, "big.ts"), "const x = 1;\n".repeat(42));
      vi.mocked(opEditedSourcePaths).mockReturnValueOnce(["big.ts"]);
      const note = groundTruthSizesNote("op-bv", "Done — big.ts is 294 lines.", "sess-size");
      expect(note).toContain("42 lines");
    } finally {
      clearSessionWorkRoot("sess-size");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent (null) when the reply quotes NO size — zero noise on normal edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "bv-size-"));
    try {
      const file = join(dir, "big.ts");
      writeFileSync(file, "const x = 1;\n".repeat(10));
      vi.mocked(opEditedSourcePaths).mockReturnValueOnce([file]);
      expect(groundTruthSizesNote("op-bv", "Done — renamed the type across the repo, tsc clean.", undefined)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when a size was quoted but no source file was edited", () => {
    vi.mocked(opEditedSourcePaths).mockReturnValueOnce([]);
    expect(groundTruthSizesNote("op-bv", "The file is 400 lines.", undefined)).toBeNull();
  });
});
