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

import { formatGitError } from "./git-error.js";

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
