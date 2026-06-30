import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import fg from "fast-glob";

// CLASS LOCK for the path-resolution seam (see the silent-seam-regressions
// memory + the 2026-06-29 fix that routed glob/grep/bash through the canonical
// resolver). The bug class: a tool that opens a caller-supplied path rolls its
// OWN absolutization (`resolve(cwd, path)` / `join(workspacePath(), …)`) instead
// of the one canonical resolver (resolveAgentPath). That re-introduces both the
// "fails first, then works" tilde/anchor bug AND a TOCTOU split-brain with the
// security gate (which resolves via the SAME resolver).
//
// This test fails the moment a NEW tool extracts a path arg without routing
// through a canonical resolver — so the whole class can't regress one tool at a
// time. A genuinely intentional exception goes in ALLOWLIST with a reason.

// Resolvers that keep a tool in lockstep with the gate: the canonical
// resolveAgentPath(From), its media/image specializations, the glob/grep search
// helpers, and the uploads-ref mapper (all defined in workspace/paths.ts or thin
// wrappers over it).
const CANONICAL_RESOLVERS =
  /\b(resolveAgentPath|resolveAgentPathFrom|resolveMediaPath|resolveLocalImagePath|searchBase|searchRoot|mapUploadsRef)\b/;

// A tool that EXTRACTS a caller path arg as a real value (not a comment mention).
const EXTRACTS_PATH_ARG =
  /String\(\s*args\.(path|file_path|dir|directory)\b|args\.(path|file_path|dir|directory)\s+as\s+string/;

// Intentional, documented exceptions.
const ALLOWLIST: Record<string, string> = {
  // create_chart writes its PNG output UNDER the workspace by design (its
  // file_path is described as "saved under the workspace"), so it anchors to
  // workspacePath() rather than the project root the canonical resolver uses.
  // Revisit if it ever needs to open arbitrary caller paths.
  "src/tools/chart-tools.ts": "output tool, intentionally workspace-anchored",
};

describe("path-resolution class lock", () => {
  it("every tool that resolves a caller path routes through the canonical resolver", async () => {
    const files = await fg("src/tools/**/*.ts", { ignore: ["**/*.test.ts"] });
    const violations: string[] = [];
    for (const file of files.sort()) {
      if (file in ALLOWLIST) continue;
      const src = readFileSync(file, "utf8");
      if (EXTRACTS_PATH_ARG.test(src) && !CANONICAL_RESOLVERS.test(src)) {
        violations.push(file);
      }
    }
    expect(violations, violations.length
      ? `These tools resolve a caller path WITHOUT the canonical resolver (route them through ` +
        `resolveAgentPath so they match the security gate, or add to ALLOWLIST with a reason):\n  ` +
        violations.join("\n  ")
      : "ok",
    ).toEqual([]);
  });

  it("the allowlisted exception still exists (no stale allowlist entries)", async () => {
    const files = new Set(await fg("src/tools/**/*.ts"));
    for (const f of Object.keys(ALLOWLIST)) expect(files.has(f), `stale allowlist entry: ${f}`).toBe(true);
  });
});
