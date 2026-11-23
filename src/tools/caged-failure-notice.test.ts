// A build's own command runs in the shell cage. When the cage refuses it a
// local database or a local model, the failure the builder reads must say so
// (GitHub issue #15): the shell tool did, a build's "exited 1" did not.
import { describe, it, expect } from "vitest";
import { cagedFailureNotice } from "./caged-failure-notice.js";
import { cageDenialNotices } from "../sandbox/index.js";
import type { CagedRunOutcome } from "./caged-spawn.js";

const REFUSED = "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)\n";
const listening = () => true;
const dead = () => false;

function exited(code: number, stdout: string, stderr = "", sandboxMode: "guarded" | "host" = "guarded"): CagedRunOutcome {
  return { kind: "exit", code, signal: null, stdout, stderr, durationMs: 10, sandboxMode } as CagedRunOutcome;
}

describe("cagedFailureNotice", () => {
  for (const platform of ["win32", "linux"] as const) {
    it(`${platform}: a failed build whose test was refused a listening loopback port is told it was the cage`, () => {
      const notice = cagedFailureNotice(exited(1, "FAIL db.test.ts\n", REFUSED), listening, platform);
      expect(notice.startsWith("\n[sandbox: loopback port 5432 refused")).toBe(true);
      expect(notice).toContain("a service IS listening on it");
    });
  }

  it("reads the refusal from either stream", () => {
    expect(cagedFailureNotice(exited(1, REFUSED), listening, "win32")).toContain("port 5432");
  });

  it("says nothing when the port is not listening: the database really is down", () => {
    expect(cagedFailureNotice(exited(1, "", REFUSED), dead, "win32")).toBe("");
  });

  it("says nothing for a run outside the cage, a run that passed, or one that never finished", () => {
    expect(cagedFailureNotice(exited(1, "", REFUSED, "host"), listening, "win32")).toBe("");
    expect(cagedFailureNotice(exited(0, "", REFUSED), listening, "win32")).toBe("");
    expect(cagedFailureNotice({ kind: "timeout", stdout: "", stderr: REFUSED, durationMs: 10 }, listening, "win32")).toBe("");
    expect(cagedFailureNotice({ kind: "abort", durationMs: 10 }, listening, "win32")).toBe("");
  });

  it("says nothing for an ordinary failure", () => {
    expect(cagedFailureNotice(exited(2, "", "error TS2322: Type 'string' is not assignable to type 'number'.\n"), listening, "win32")).toBe("");
  });
});

describe("cageDenialNotices", () => {
  it("is the list the shell tool and a build both read: nothing for clean output, the loopback notice for a refused listening port", () => {
    expect(cageDenialNotices("guarded", "all good\n", listening, "win32")).toEqual([]);
    const notices = cageDenialNotices("guarded", REFUSED, listening, "win32");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("loopback port 5432 refused");
  });
});
