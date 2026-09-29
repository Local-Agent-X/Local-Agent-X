// 2026-07-23 live failure: the first sync after the 8-day wedge re-hashed
// ~18k files, git emitted one CRLF warning per file (~2 MB of stderr), the
// old 1 MB execFile maxBuffer killed the child, and the raw warning flood was
// thrown verbatim as the sync error — unreadable in the settings UI and
// burying the actual failure. formatGitError pins the surfacing contract;
// the maxBuffer/timeout headroom lives in the git() options.
//
// 2026-09-23: the same flood, without a fatal after it. `add -A` over 27k
// files ran 275s against the 300s timeout; a kill leaves stderr holding only
// warnings, and the tail-only rule showed those instead of the timeout.
import { describe, expect, it } from "vitest";

import { formatGitError, isAuthRejection, pushFailureMessage } from "./git-error.js";

const flood = (n: number) => Array.from({ length: n }, (_, i) =>
  `warning: in the working copy of 'memory/f${i}.md', LF will be replaced by CRLF`,
).join("\n");

describe("formatGitError", () => {
  it("falls back to the exec message when git printed nothing", () => {
    expect(formatGitError({ message: "spawn git ENOENT" })).toBe("spawn git ENOENT");
    expect(formatGitError({ stderr: "  \n", message: "timed out" })).toBe("timed out");
  });

  it("passes a short stderr through untouched", () => {
    expect(formatGitError({ stderr: "fatal: repository not found\n", message: "exit 128" }))
      .toBe("fatal: repository not found");
  });

  it("drops a warning flood and keeps the fatal git printed after it", () => {
    const out = formatGitError({ stderr: `${flood(20_000)}\nfatal: the real problem`, message: "exit 128" });
    expect(out).toBe("fatal: the real problem");
  });

  it("surfaces the exec message when a killed child left only warnings", () => {
    const out = formatGitError({ stderr: flood(20_000), message: "Command failed: git add -A" });
    expect(out).toBe("Command failed: git add -A");
  });

  it("keeps the TAIL when the real error itself is longer than the cap", () => {
    const long = Array.from({ length: 200 }, (_, i) => `error: path ${i} is unmerged`).join("\n");
    const out = formatGitError({ stderr: `${long}\nfatal: the real problem`, message: "exit 128" });
    expect(out.length).toBeLessThanOrEqual(2010);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("fatal: the real problem")).toBe(true);
  });

  it("names the git subcommand that failed", () => {
    expect(formatGitError({ stderr: flood(50), message: "Command failed" }, "add"))
      .toBe("git add: Command failed");
  });
});

// 2026-09-29 live failure (this station): a PAT expired, and every push
// reported "remote has commits this machine doesn't have … Hit Force Pull",
// with "remote: Invalid username or token" printed inside its own root-cause
// line. Force Pull runs the same git with the same dead credential, so the
// one next step the UI offered could not work.
const REJECTED = "remote: Invalid username or token. Password authentication is not supported for Git operations.";

describe("isAuthRejection", () => {
  it("recognizes the shapes a remote uses to refuse a credential", () => {
    expect(isAuthRejection(REJECTED)).toBe(true);
    expect(isAuthRejection("fatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe(true);
    expect(isAuthRejection("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true);
    expect(isAuthRejection("remote: Permission to petermanrique101-sys/Primal-Memory.git denied")).toBe(true);
    expect(isAuthRejection("The requested URL returned error: 403 Forbidden")).toBe(true);
  });

  it("does not fire on a real divergence, a missing repo, or a timeout", () => {
    expect(isAuthRejection("! [rejected] main -> main (non-fast-forward)")).toBe(false);
    expect(isAuthRejection("fatal: repository not found")).toBe(false);
    expect(isAuthRejection("Command failed: git add -A")).toBe(false);
    expect(isAuthRejection(undefined, undefined)).toBe(false);
  });
});

describe("pushFailureMessage", () => {
  it("names the credential when the token was refused, and rules out Force Pull", () => {
    const out = pushFailureMessage(
      `git push: ${REJECTED}`,
      `git pull: ${REJECTED}`,
      `git pull: ${REJECTED}`,
    );
    expect(out).toContain("rejected this machine's credential");
    expect(out).toContain("Settings → Sync");
    expect(out).toContain("Force Pull will not help");
    expect(out).not.toContain("remote has commits this machine doesn't have");
  });

  it("finds the auth cause when only the recovery attempts carry it", () => {
    const out = pushFailureMessage("! [rejected] main -> main (fetch first)", `git pull: ${REJECTED}`);
    expect(out).toContain("rejected this machine's credential");
  });

  it("keeps the divergence message for a genuine non-fast-forward", () => {
    const out = pushFailureMessage(
      "! [rejected] main -> main (non-fast-forward)",
      "rebase in progress",
      "Automatic merge failed",
    );
    expect(out).toContain("remote has commits this machine doesn't have");
    expect(out).toContain("Hit Force Pull");
    expect(out).toContain("root cause: rebase failed: rebase in progress; merge fallback failed: Automatic merge failed");
  });

  it("omits the root-cause clause when neither recovery attempt ran", () => {
    const out = pushFailureMessage("! [rejected] main -> main (non-fast-forward)");
    expect(out).not.toContain("root cause");
    expect(out).toContain("Original git error: ! [rejected] main -> main (non-fast-forward)");
  });

  it("reports only the first line of a multi-line git error", () => {
    const out = pushFailureMessage("! [rejected] main -> main\nhelp: see the docs");
    expect(out).not.toContain("help: see the docs");
  });
});
