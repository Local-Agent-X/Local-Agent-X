import { describe, it, expect } from "vitest";
import {
  looksLikeCleanupSweep,
  isEmptyGrepResult,
  claimsCleanupDone,
  shellSearchPattern,
  noteCleanupEvidence,
  checkCleanupVerify,
  createCleanupVerifyState,
  CLEANUP_VERIFY_MAX_NUDGES,
  type CleanupToolResult,
} from "./cleanup-verify.js";

// The first is the exact scenario the three models ran in the live comparison —
// a project-wide removal reported done off poisoned memory without a re-search.
const CLEANUPS = [
  "We switched this app off Tailscale. There are still out-of-date tailnet references left over in the code — go through the project and finish cleaning them up.",
  "Remove every reference to the deprecated flag throughout the project.",
  "Delete all usages of the old logger across the codebase.",
  "Migrate the whole codebase off moment.js and remove it from this project.",
  "Get rid of all the dead feature-flag mentions in the repo.",
  "Strip out the legacy auth code everywhere.",
];

const NOT_CLEANUPS = [
  "Add a logout button to the settings page.",
  "Rename getUser to fetchUser everywhere.", // rename: a clean grep doesn't prove it
  "Remove the unused import in bar.ts.",      // single named spot, no breadth
  "Clean up this function.",                  // no breadth cue
  "What's the capital of France?",
  "Summarize all the key points in this document.",
];

describe("looksLikeCleanupSweep", () => {
  it("fires on project-wide removal/cleanup tasks", () => {
    for (const t of CLEANUPS) expect(looksLikeCleanupSweep(t), t).toBe(true);
  });
  it("does NOT fire on non-removal / single-spot / read-only tasks", () => {
    for (const t of NOT_CLEANUPS) expect(looksLikeCleanupSweep(t), t).toBe(false);
  });
  it("ignores trivially short input", () => {
    expect(looksLikeCleanupSweep("remove all")).toBe(false);
    expect(looksLikeCleanupSweep("")).toBe(false);
  });
});

describe("isEmptyGrepResult", () => {
  it("recognizes grep's zero-match sentinel", () => {
    expect(isEmptyGrepResult("No matches found.")).toBe(true);
    expect(isEmptyGrepResult("  No matches found.\n")).toBe(true);
    expect(isEmptyGrepResult("No matches found")).toBe(true);
  });
  it("does NOT treat a content-mode line that mentions the phrase as empty", () => {
    expect(isEmptyGrepResult('src/x.ts:12:// log("No matches found.")')).toBe(false);
    expect(isEmptyGrepResult("src/a.ts\nsrc/b.ts")).toBe(false);
  });
});

describe("claimsCleanupDone — only positive, un-negated completion claims", () => {
  it("matches a confident done-claim (the exact false bubble Grok produced)", () => {
    expect(claimsCleanupDone("**Cleanup complete — no active Tailscale/tailnet code remains.**")).toBe(true);
    expect(claimsCleanupDone("Done — all tailnet references removed.")).toBe(true);
    expect(claimsCleanupDone("All references removed; the cleanup is complete.")).toBe(true);
  });
  it("does NOT match an honest not-done / in-progress wrap-up (must never be retracted)", () => {
    expect(claimsCleanupDone("**Status: Not done.** Fresh grep still returns many matches.")).toBe(false);
    expect(claimsCleanupDone("I've edited a few files but references still remain in app/src.")).toBe(false);
    expect(claimsCleanupDone("This is a partial cleanup — more to remove.")).toBe(false);
    expect(claimsCleanupDone("I haven't finished; some mentions are left.")).toBe(false);
  });
  it("is empty-safe", () => {
    expect(claimsCleanupDone("")).toBe(false);
  });
});

describe("checkCleanupVerify + noteCleanupEvidence", () => {
  it("nudges repeatedly, bounded, when a cleanup wraps up with no clean search in evidence", () => {
    const s = createCleanupVerifyState();
    for (let i = 1; i <= CLEANUP_VERIFY_MAX_NUDGES; i++) {
      const r = checkCleanupVerify(s);
      expect(r.nudge).toContain(`${i}/${CLEANUP_VERIFY_MAX_NUDGES}`);
      expect(s.unverified).toBe(true);
    }
    expect(checkCleanupVerify(s).nudge).toBeNull();
    expect(s.unverified).toBe(true);
  });

  it("stays quiet and clears the verdict once a grep came back empty", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([{ toolName: "grep", content: "No matches found.", status: "ok" }], s);
    expect(s.confirmedClean).toBe(true);
    const r = checkCleanupVerify(s);
    expect(r.nudge).toBeNull();
    expect(s.unverified).toBe(false);
  });

  it("a grep that still returns matches is NOT proof — verdict stays unverified", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([{ toolName: "grep", content: "src/a.ts\nsrc/b.ts", status: "ok" }], s);
    expect(s.confirmedClean).toBe(false);
    expect(checkCleanupVerify(s).nudge).toBeTruthy();
    expect(s.unverified).toBe(true);
  });

  it("keeps nudging after a re-grep still returns matches, until bounded cap", () => {
    const s = createCleanupVerifyState();
    for (let i = 1; i <= CLEANUP_VERIFY_MAX_NUDGES; i++) {
      noteCleanupEvidence([
        { toolName: "grep", pattern: "tailnet|tailscale", content: `src/still-${i}.ts`, status: "ok" },
      ], s);
      const r = checkCleanupVerify(s);
      expect(r.nudge).toContain(`${i}/${CLEANUP_VERIFY_MAX_NUDGES}`);
      expect(s.unverified).toBe(true);
    }
    noteCleanupEvidence([
      { toolName: "grep", pattern: "tailnet|tailscale", content: "src/still-final.ts", status: "ok" },
    ], s);
    expect(checkCleanupVerify(s).nudge).toBeNull();
    expect(s.unverified).toBe(true);
  });

  it("ignores an errored grep and non-search bash empty-looking output", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([
      { toolName: "grep", content: "No matches found.", status: "error" },
      { toolName: "bash", command: "echo 'No matches found.'", content: "No matches found.", status: "ok" },
    ], s);
    expect(s.confirmedClean).toBe(false);
  });

  it("recovery: a clean grep after the nudge clears the verdict", () => {
    const s = createCleanupVerifyState();
    expect(checkCleanupVerify(s).nudge).toBeTruthy(); // nudged, unverified
    noteCleanupEvidence([{ toolName: "grep", content: "No matches found.", status: "ok" }], s);
    checkCleanupVerify(s); // re-evaluate at the next wrap-up
    expect(s.unverified).toBe(false);
  });
});

describe("shell search evidence", () => {
  it("extracts patterns from repository content searches", () => {
    expect(shellSearchPattern('rg -n "tailnet|tailscale" app/src')).toBe("tailnet|tailscale");
    expect(shellSearchPattern('rg --glob "!node_modules" -n "tailnet|tailscale" app/src')).toBe("tailnet|tailscale");
    expect(shellSearchPattern("git grep -n 'oldName' -- src")).toBe("oldName");
    expect(shellSearchPattern("grep -R legacy .")).toBe("legacy");
  });

  it("does not treat arbitrary shell greps as cleanup evidence", () => {
    expect(shellSearchPattern("ps aux | grep tailnet")).toBeNull();
    expect(shellSearchPattern("pgrep -f tailnet")).toBeNull();
    expect(shellSearchPattern("grep tailnet README.md")).toBeNull();
  });

  it("counts shell rg hits as outstanding cleanup evidence", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([
      {
        toolName: "bash",
        command: 'rg -n "tailnet|tailscale" app/src',
        content: "[ok, exit_code=0, duration_ms=10]\napp/src/a.ts:1:tailnet",
        status: "ok",
      },
    ], s);
    expect(s.confirmedClean).toBe(false);
    expect(checkCleanupVerify(s).nudge).toContain("STILL returned matches");
  });

  it("treats shell rg exit 1 with no output as clean search evidence", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([
      {
        toolName: "bash",
        command: 'rg -n "tailnet|tailscale" app/src',
        content: "[error, exit_code=1, duration_ms=10]\nExit code: 1",
        status: "error",
      },
    ], s);
    expect(s.confirmedClean).toBe(true);
    expect(checkCleanupVerify(s).nudge).toBeNull();
    expect(s.unverified).toBe(false);
  });
});

describe("per-pattern tracking — a narrow empty grep can't vouch for a broad one", () => {
  const grep = (pattern: string, content: string): CleanupToolResult =>
    ({ toolName: "grep", pattern, content, status: "ok" });
  const EMPTY = "No matches found.";
  const HITS = "app/src/voice/errors.ts:24:  same Tailscale network";

  it("regression (the live run): narrow `tailnetAddr` empty does NOT clear a broad `tailnet|Tailscale` that still matches", () => {
    const s = createCleanupVerifyState();
    // The renamed identifier is genuinely gone…
    noteCleanupEvidence([grep("tailnetAddr", EMPTY)], s);
    // …but the broad target still has live matches (user-facing strings).
    noteCleanupEvidence([grep("tailnet|Tailscale|tailnetAddr", HITS)], s);
    expect(s.confirmedClean).toBe(false);
    const r = checkCleanupVerify(s);
    expect(r.nudge).toMatch(/still returned matches|narrower/i);
    expect(s.unverified).toBe(true);
  });

  it("does not un-latch on order: a later narrow empty after a broad match stays unverified", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([grep("tailnet|Tailscale", HITS)], s); // broad: matches
    noteCleanupEvidence([grep("tailnetAddr", EMPTY)], s);       // narrow: clean
    expect(s.confirmedClean).toBe(false); // broad pattern still outstanding
  });

  it("recovery: re-running the SAME broad pattern empty clears it", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([grep("tailnet|Tailscale", HITS)], s);
    expect(s.confirmedClean).toBe(false);
    noteCleanupEvidence([grep("tailnet|Tailscale", EMPTY)], s); // fixed, re-grep clean
    expect(s.confirmedClean).toBe(true);
    expect(checkCleanupVerify(s).nudge).toBeNull();
  });

  it("normalizes reordered alternations to the same bucket", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([grep("tailnet|Tailscale", HITS)], s);
    // re-grep with branches reordered + different case — same logical search
    noteCleanupEvidence([grep("tailscale|tailnet", EMPTY)], s);
    expect(s.confirmedClean).toBe(true);
  });
});
