import { describe, it, expect } from "vitest";
import {
  createVerifyGateState,
  noteVerifyEvidence,
  checkVerifyGate,
  opEditedSourceUnverified,
  recordExternalVerify,
  isSourceFile,
  type VerifyTurnAction,
} from "./verify-gate.js";

// verify-gate is the build-verification guard: an op edited source but never
// reached a clean build/type-check. These tests pin the class behaviour — it is
// agnostic to any one project or rename; it fires on the EVIDENCE of an
// unverified or failing edit, whatever the task.

const edit = (filePath: string): VerifyTurnAction => ({ tool: "edit", filePath });
const bash = (command: string, status: "ok" | "error"): VerifyTurnAction => ({ tool: "bash", command, status });
const del = (filePath: string): VerifyTurnAction => ({ tool: "delete_file", filePath });

describe("isSourceFile — which extensions demand a verify", () => {
  it("flags compiled/checked languages, not pure data files", () => {
    for (const p of ["a.ts", "b.tsx", "c.js", "d.py", "e.go", "f.rs", "g.java"]) {
      expect(isSourceFile(p)).toBe(true);
    }
    for (const p of ["README.md", "config.json", "styles.css", "page.html", "data.yaml"]) {
      expect(isSourceFile(p)).toBe(false);
    }
  });
});

describe("checkVerifyGate — edited but never verified", () => {
  it("nudges once (gently) when source changed and nothing verified it", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/chat/useChat.ts")], s);

    const first = checkVerifyGate(s);
    expect(first.nudge).toMatch(/haven't run/i);
    expect(first.nudge).not.toMatch(/FAILED/);

    // fire-once: a second wrap-up with the same state is silent.
    expect(checkVerifyGate(s).nudge).toBeNull();
  });

  it("does not fire on a pure-conversation turn (no source edit)", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([{ tool: "read", filePath: "src/x.ts" }, bash("ls", "ok")], s);
    expect(checkVerifyGate(s).nudge).toBeNull();
    expect(opEditedSourceUnverified(s)).toBe(false);
  });

  it("does not fire when only data files (.md/.json) were edited", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("README.md"), edit("package.json")], s);
    expect(checkVerifyGate(s).nudge).toBeNull();
    expect(opEditedSourceUnverified(s)).toBe(false);
  });
});

describe("checkVerifyGate — verified clean", () => {
  it("stays silent once a verify ran OK after the edit", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "ok")], s);
    expect(checkVerifyGate(s).nudge).toBeNull();
    expect(opEditedSourceUnverified(s)).toBe(false);
  });

  it("a non-verify command does not count as verification", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("git status", "ok")], s);
    expect(checkVerifyGate(s).nudge).toMatch(/haven't run/i);
  });

  it("a later edit invalidates an earlier clean verify", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("npm run typecheck", "ok")], s);
    noteVerifyEvidence([edit("src/b.ts")], s);
    expect(opEditedSourceUnverified(s)).toBe(true);
    expect(checkVerifyGate(s).nudge).toMatch(/haven't run/i);
  });
});

describe("checkVerifyGate — verified but FAILED (the ship-broken-and-claim-done case)", () => {
  it("nudges sharply when a verify ran and exited error", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/chat/ChatScreen.tsx"), bash("tsc --noEmit", "error")], s);
    const r = checkVerifyGate(s);
    expect(r.nudge).toMatch(/STOP/);
    expect(r.nudge).toMatch(/FAILED/);
    expect(opEditedSourceUnverified(s)).toBe(true);
  });

  it("re-fires across repeated red wrap-ups, then bounds itself", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "error")], s);
    // Even after the gentle one-shot would be spent, the failing build keeps
    // getting the strong nudge — up to the bound, then it yields to the spiral
    // breakers + the partial outcome label.
    expect(checkVerifyGate(s).nudge).toMatch(/FAILED/);
    expect(checkVerifyGate(s).nudge).toMatch(/FAILED/);
    expect(checkVerifyGate(s).nudge).toBeNull();
  });

  it("a clean verify after a failure clears the red state", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc", "error")], s);
    noteVerifyEvidence([bash("tsc", "ok")], s);
    expect(checkVerifyGate(s).nudge).toBeNull();
    expect(opEditedSourceUnverified(s)).toBe(false);
  });

  it("a fresh edit after a failure resets to re-verify (a fix attempt)", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc", "error")], s);
    noteVerifyEvidence([edit("src/a.ts")], s); // the fix
    // No longer flagged as a failed build (must be re-verified), but still
    // unverified overall → outcome stays partial until a clean run.
    expect(opEditedSourceUnverified(s)).toBe(true);
  });
});

describe("test-deletion tripwire — deleting a test to dodge a red suite", () => {
  it("nudges (once) when a test file is deleted via delete_file", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([del("tests/integration/undo-zero-cost.test.ts")], s);
    const r = checkVerifyGate(s);
    expect(r.nudge).toMatch(/deleted test file/i);
    expect(r.nudge).toMatch(/NOT allowed/);
    expect(r.nudge).toContain("undo-zero-cost.test.ts");
    // fire-once
    expect(checkVerifyGate(s).nudge).toBeNull();
  });

  it("fires even on an otherwise-clean op (independent of edit/verify state)", () => {
    const s = createVerifyGateState();
    // edited + self-verified clean, but ALSO deleted a test — the tripwire wins.
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "ok"), del("src/a.spec.ts")], s);
    expect(checkVerifyGate(s).nudge).toMatch(/deleted test file/i);
  });

  it("catches a bash `rm` of a test file too", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([bash("rm src/foo.test.ts", "ok")], s);
    expect(s.deletedTestPaths).toContain("src/foo.test.ts");
    expect(checkVerifyGate(s).nudge).toMatch(/deleted test file/i);
  });

  it("does not fire when a NON-test file is deleted", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([del("src/legacy-helper.ts")], s);
    expect(s.deletedTestPaths).toEqual([]);
    expect(checkVerifyGate(s).nudge).toBeNull();
  });
});

describe("editedPaths — what the orchestrator build-verify gate locates the project from", () => {
  it("records distinct edited source paths in order, ignoring data files and reads", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), { tool: "read", filePath: "src/z.ts" }, edit("README.md")], s);
    noteVerifyEvidence([edit("src/b.ts"), edit("src/a.ts")], s); // a.ts repeat is deduped
    expect(s.editedPaths).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("recordExternalVerify — the orchestrator's own build verdict", () => {
  it("a passing orchestrator build clears the unverified flag (→ clean)", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts")], s);
    expect(opEditedSourceUnverified(s)).toBe(true);
    recordExternalVerify(s, true);
    expect(opEditedSourceUnverified(s)).toBe(false);
  });

  it("a failing orchestrator build keeps it unverified (→ partial)", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc", "ok")], s); // model self-verified clean
    recordExternalVerify(s, false); // ...but the orchestrator's run disagrees
    expect(opEditedSourceUnverified(s)).toBe(true);
  });

  it("is a no-op when nothing was edited (never invents a verdict)", () => {
    const s = createVerifyGateState();
    recordExternalVerify(s, true);
    expect(s.verifiedSinceEdit).toBe(false);
  });
});

describe("opEditedSourceUnverified — outcome-label verdict", () => {
  it("is true for both never-verified and failed-verify, false once clean", () => {
    const never = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts")], never);
    expect(opEditedSourceUnverified(never)).toBe(true);

    const failed = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc", "error")], failed);
    expect(opEditedSourceUnverified(failed)).toBe(true);

    const clean = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc", "ok")], clean);
    expect(opEditedSourceUnverified(clean)).toBe(false);
  });
});
