import { describe, it, expect } from "vitest";
import {
  createVerifyGateState,
  noteVerifyEvidence,
  checkVerifyGate,
  opEditedSourceUnverified,
  recordExternalVerify,
  isSourceFile,
  guessTestSubject,
  decideDeletedTest,
  sourceDoneEvidence,
  type VerifyTurnAction,
} from "./verify-gate.js";

// verify-gate is the build-verification guard: an op edited source but never
// reached a clean build/type-check. These tests pin the class behaviour — it is
// agnostic to any one project or rename; it fires on the EVIDENCE of an
// unverified or failing edit, whatever the task.

const edit = (filePath: string): VerifyTurnAction => ({ tool: "edit", filePath });
const bash = (command: string, status: "ok" | "error"): VerifyTurnAction => ({ tool: "bash", command, status });
const bashAt = (command: string, cwd: string, status: "ok" | "error"): VerifyTurnAction => ({ tool: "bash", command, cwd, status });
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

  it("covers the whole TS family — .mts/.cts/.mjs/.cjs count as source (no drift vs language-intel)", () => {
    for (const p of ["a.mts", "b.cts", "c.mjs", "d.cjs"]) {
      expect(isSourceFile(p)).toBe(true);
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

  it("does NOT credit a repo typecheck as verification for an edited workspace app", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([
      edit("C:/Users/manri/Documents/Local Agent X/workspace/apps/fastmail-dashboard/app.js"),
      bash('cd "C:/Users/manri/local-agent-x" && npx tsc --noEmit', "ok"),
    ], s);

    expect(checkVerifyGate(s).nudge).toMatch(/haven't run/i);
    expect(opEditedSourceUnverified(s)).toBe(true);
  });

  it("credits a verify command that targets the edited workspace app", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([
      edit("C:/Users/manri/Documents/Local Agent X/workspace/apps/fastmail-dashboard/app.js"),
      bash('cd "C:/Users/manri/Documents/Local Agent X/workspace/apps/fastmail-dashboard" && npm run build', "ok"),
    ], s);

    expect(checkVerifyGate(s).nudge).toBeNull();
    expect(opEditedSourceUnverified(s)).toBe(false);
  });

  it("credits an HTTP smoke only when it targets the edited app or connector route", () => {
    const appPath = "C:/Users/manri/Documents/Local Agent X/workspace/apps/fastmail-dashboard/app.js";

    const wrong = createVerifyGateState();
    noteVerifyEvidence([edit(appPath), bash("curl.exe -f http://127.0.0.1:7007/api/health", "ok")], wrong);
    expect(checkVerifyGate(wrong).nudge).toMatch(/haven't run/i);

    const appSmoke = createVerifyGateState();
    noteVerifyEvidence([edit(appPath), bash("curl.exe -f http://127.0.0.1:7007/apps/fastmail-dashboard/index.html", "ok")], appSmoke);
    expect(checkVerifyGate(appSmoke).nudge).toBeNull();

    const connectorSmoke = createVerifyGateState();
    noteVerifyEvidence([edit(appPath), bash("curl.exe -f http://127.0.0.1:7007/api/connectors/fastmail/jmap/session", "ok")], connectorSmoke);
    expect(checkVerifyGate(connectorSmoke).nudge).toBeNull();
  });

  it("credits executor cwd when it is the edited workspace app", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([
      edit("C:/Users/manri/Documents/Local Agent X/workspace/apps/fastmail-dashboard/app.js"),
      bashAt("npm run build", "C:/Users/manri/Documents/Local Agent X/workspace/apps/fastmail-dashboard", "ok"),
    ], s);

    expect(checkVerifyGate(s).nudge).toBeNull();
  });
});

// Python's stdlib test runner (`python -m unittest`) needs no pip install, so
// it's how a model verifies a Python task — but the gate used to be blind to it
// (only pytest/mypy were recognized). That blindness both punished honest
// verification and hid real test failures. These pin the language-completeness.
describe("checkVerifyGate — Python stdlib unittest is a real verify", () => {
  it("credits a passing `python -m unittest` (no spurious nudge)", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("poker.py"), bash("python3 -m unittest poker_test", "ok")], s);
    expect(checkVerifyGate(s).nudge).toBeNull();
    expect(opEditedSourceUnverified(s)).toBe(false);
  });

  it("nudges SHARPLY when `python -m unittest` FAILED (don't claim done over red)", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("poker.py"), bash("python3 -m unittest poker_test", "error")], s);
    const r = checkVerifyGate(s);
    expect(r.nudge).toMatch(/STOP/);
    expect(r.nudge).toMatch(/FAILED/);
    expect(opEditedSourceUnverified(s)).toBe(true);
  });

  it("running the module (`python file.py`) is NOT a verify — still nudges", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("poker.py"), bash("python3 poker.py", "ok")], s);
    expect(checkVerifyGate(s).nudge).toMatch(/haven't run/i);
    expect(opEditedSourceUnverified(s)).toBe(true);
  });

  it("also credits `python -m pytest` and the `py` launcher / trailing flags", () => {
    for (const cmd of ["python3 -m pytest", "py -m unittest", "python -m unittest -v"]) {
      const s = createVerifyGateState();
      noteVerifyEvidence([edit("a.py"), bash(cmd, "ok")], s);
      expect(checkVerifyGate(s).nudge, cmd).toBeNull();
    }
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

// Language-service signal (fed by the middleware from post-edit-diagnostics'
// per-op state): outstanding INTRODUCED type errors are strong negative
// evidence (sharp path, same tier as a failed verify); lsp-clean is weak
// positive evidence (softens the gentle nudge's tone, never replaces a build).
describe("checkVerifyGate — language-service signal", () => {
  it("outstanding introduced errors → SHARP nudge naming introduced type errors", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts")], s);
    const r = checkVerifyGate(s, { outstanding: true, clean: false });
    expect(r.nudge).toMatch(/STOP/);
    expect(r.nudge).toMatch(/INTRODUCED type errors/i);
    expect(r.nudge).not.toMatch(/haven't run/i); // not the gentle path
  });

  it("outstanding path shares the bounded fail-nudge cap with the failed-verify path", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts")], s);
    const lsp = { outstanding: true, clean: false };
    expect(checkVerifyGate(s, lsp).nudge).toMatch(/STOP/);
    expect(checkVerifyGate(s, lsp).nudge).toMatch(/STOP/);
    expect(checkVerifyGate(s, lsp).nudge).toBeNull(); // MAX_FAIL_NUDGES reached
  });

  it("a verify that RAN and FAILED keeps its own message over the LSP wording", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "error")], s);
    const r = checkVerifyGate(s, { outstanding: true, clean: false });
    expect(r.nudge).toMatch(/build\/type-check\/test run FAILED/);
    expect(r.nudge).not.toMatch(/language service/i);
  });

  it("a grounded clean verify silences even a (stale) outstanding flag", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "ok")], s);
    expect(checkVerifyGate(s, { outstanding: true, clean: false }).nudge).toBeNull();
  });

  it("lsp-clean + nothing else verified → GENTLE nudge with the acknowledging clause", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts")], s);
    const r = checkVerifyGate(s, { outstanding: false, clean: true });
    expect(r.nudge).toMatch(/types check clean, but run the build\/tests/i);
    expect(r.nudge).toMatch(/type-clean isn't run-clean/i);
    expect(r.nudge).not.toMatch(/STOP/); // still the gentle tier...
    // ...and still fire-once: the weak positive never re-opens the nag.
    expect(checkVerifyGate(s, { outstanding: false, clean: true }).nudge).toBeNull();
  });

  it("lsp-clean never grounds the claim — the outcome label still demotes", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts")], s);
    checkVerifyGate(s, { outstanding: false, clean: true });
    expect(opEditedSourceUnverified(s)).toBe(true); // partial until a real build
  });

  it("both booleans false → byte-identical to the no-signal behavior", () => {
    const withSignal = createVerifyGateState();
    const withoutSignal = createVerifyGateState();
    noteVerifyEvidence([edit("src/chat/useChat.ts")], withSignal);
    noteVerifyEvidence([edit("src/chat/useChat.ts")], withoutSignal);
    const a = checkVerifyGate(withSignal, { outstanding: false, clean: false });
    const b = checkVerifyGate(withoutSignal);
    expect(a.nudge).toBe(b.nudge); // exact same message, not just same shape
    // Pin the pre-existing expectation unchanged: gentle wording, no ack clause.
    expect(b.nudge).toMatch(/haven't run/i);
    expect(b.nudge).not.toMatch(/types check clean/i);
    expect(checkVerifyGate(withSignal, { outstanding: false, clean: false }).nudge).toBeNull();
    expect(checkVerifyGate(withoutSignal).nudge).toBeNull();
  });
});

describe("test-deletion tripwire — detection (noteVerifyEvidence)", () => {
  it("records a test file deleted via delete_file", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([del("tests/integration/undo-zero-cost.test.ts")], s);
    expect(s.deletedTestPaths).toContain("tests/integration/undo-zero-cost.test.ts");
  });

  it("catches a bash `rm` of a test file too", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([bash("rm src/foo.test.ts", "ok")], s);
    expect(s.deletedTestPaths).toContain("src/foo.test.ts");
  });

  it("does not record a NON-test file deletion", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([del("src/legacy-helper.ts")], s);
    expect(s.deletedTestPaths).toEqual([]);
  });

  it("checkVerifyGate no longer fires on a deletion — that decision moved to the judge", () => {
    const s = createVerifyGateState();
    // Edited + self-verified clean, but ALSO deleted a test. The pure gate stays
    // silent; the async LLM judge (in the middleware) owns the dodge-vs-cleanup call.
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "ok"), del("src/a.spec.ts")], s);
    expect(checkVerifyGate(s).nudge).toBeNull();
  });
});

describe("guessTestSubject — the code a test exercises", () => {
  it("strips the .test/.spec infix, keeping the extension", () => {
    expect(guessTestSubject("src/foo.test.ts")).toBe("src/foo.ts");
    expect(guessTestSubject("a/b.spec.tsx")).toBe("a/b.tsx");
    expect(guessTestSubject("x/y.test.mjs")).toBe("x/y.mjs");
    // A non-test path is returned unchanged.
    expect(guessTestSubject("src/plain.ts")).toBe("src/plain.ts");
  });
});

describe("decideDeletedTest — nudge/label from the judge verdict", () => {
  const deleted = ["src/foo.test.ts"];

  it("dodge → nudge once + demote the label", () => {
    const r = decideDeletedTest(deleted, "dodge", false);
    expect(r.nudge).toMatch(/deleted test file/i);
    expect(r.dodge).toBe(true);
  });

  it("legit-cleanup → suppress the nudge + do NOT demote", () => {
    const r = decideDeletedTest(deleted, "legit-cleanup", false);
    expect(r.nudge).toBeNull();
    expect(r.dodge).toBe(false);
  });

  it("null (judge unavailable) → fail safe: advisory nudge, but no demotion", () => {
    const r = decideDeletedTest(deleted, null, false);
    expect(r.nudge).toMatch(/deleted test file/i);
    expect(r.dodge).toBe(false);
  });

  it("does not re-nudge once already fired (label verdict still returned)", () => {
    expect(decideDeletedTest(deleted, "dodge", true).nudge).toBeNull();
    expect(decideDeletedTest(deleted, "dodge", true).dodge).toBe(true);
  });

  it("empty deletion set (test restored) → no nudge, no demotion", () => {
    const r = decideDeletedTest([], "dodge", false);
    expect(r.nudge).toBeNull();
    expect(r.dodge).toBe(false);
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

describe("sourceDoneEvidence — adapter into canonical claim grounding", () => {
  it("maps a clean verify after source edits to build-clean evidence", () => {
    const s = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "ok")], s);
    expect(sourceDoneEvidence(s)).toEqual(["build-clean"]);
  });

  it("does not produce build-clean evidence for missing or failed verification", () => {
    const never = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts")], never);
    expect(sourceDoneEvidence(never)).toEqual([]);

    const failed = createVerifyGateState();
    noteVerifyEvidence([edit("src/a.ts"), bash("tsc --noEmit", "error")], failed);
    expect(sourceDoneEvidence(failed)).toEqual([]);
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
