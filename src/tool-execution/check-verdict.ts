// What a CHECK (a build, a type-check, a test run, a smoke request) says about the
// work, read from its tool status. The one reading every guard and gate uses, so
// none of them invents its own.
//
//   passed  the check ran and came back clean (ok)
//   failed  the check ran and reported a problem (error: a non-zero exit)
//   none    no verdict: it never ran (blocked by policy, declined, cancelled) or
//           ran without answering (timed out, killed mid-run)
//
// "none" is not "failed". Telling the model its build is red when the build never
// ran sends it to fix code that may be fine: a blocked curl once produced "STOP:
// your last build/type-check/test run FAILED" and two wasted turns (2026-10-14).
//
// Leaf module: type-only imports, safe from any layer.

import type { ToolResultStatus } from "../types.js";

export type CheckVerdict = "passed" | "failed" | "none";

export function checkVerdict(status: ToolResultStatus | "cancelled" | undefined): CheckVerdict {
  if (status === "ok") return "passed";
  if (status === "error") return "failed";
  return "none";
}
