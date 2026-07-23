// 2026-07-23 live failure: the first sync after the 8-day wedge re-hashed
// ~18k files, git emitted one CRLF warning per file (~2 MB of stderr), the
// old 1 MB execFile maxBuffer killed the child, and the raw warning flood was
// thrown verbatim as the sync error — unreadable in the settings UI and
// burying the actual failure. formatGitError pins the surfacing contract;
// the maxBuffer/timeout headroom lives in the git() options.
import { describe, expect, it } from "vitest";

import { formatGitError } from "./index.js";

describe("formatGitError", () => {
  it("falls back to the exec message when git printed nothing", () => {
    expect(formatGitError({ message: "spawn git ENOENT" })).toBe("spawn git ENOENT");
    expect(formatGitError({ stderr: "  \n", message: "timed out" })).toBe("timed out");
  });

  it("passes a short stderr through untouched", () => {
    expect(formatGitError({ stderr: "fatal: repository not found\n", message: "exit 128" }))
      .toBe("fatal: repository not found");
  });

  it("keeps the TAIL of a warning flood — git prints the fatal error last", () => {
    const flood = Array.from({ length: 20_000 }, (_, i) =>
      `warning: in the working copy of 'memory/f${i}.md', LF will be replaced by CRLF`,
    ).join("\n") + "\nfatal: the real problem";
    const out = formatGitError({ stderr: flood, message: "exit 128" });
    expect(out.length).toBeLessThanOrEqual(2010);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("fatal: the real problem")).toBe(true);
  });
});
