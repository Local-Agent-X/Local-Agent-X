import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Generated artifacts that a build gate byte-compares must be pinned to the
 * generator's line endings.
 *
 * The bug this guards: scripts/gen-codebase-map.mjs emits LF
 * (`out.join("\n")`) and its --check mode compares raw strings
 * (`existing !== content`). With core.autocrlf=true — the Windows default —
 * git materializes a CRLF working copy on checkout, so --check compares CRLF
 * against LF, calls a perfectly current map "stale", and fails `npm run build`
 * for every Windows dev on every pull that touches the map.
 *
 * This test is the ONLY guard: the failure is invisible on Linux/macOS CI,
 * where checkouts are LF regardless of what .gitattributes says.
 */
const BYTE_COMPARED_ARTIFACTS = ["docs/codebase-map.md"];

function effectiveEol(path: string): string {
  // check-attr reports the EFFECTIVE attribute (precedence + last-match-wins
  // included), so this asserts the real rule rather than a substring in the file.
  const out = execFileSync("git", ["check-attr", "eol", "--", path], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return out.trim().split(": ").pop() ?? "";
}

describe("generated artifacts gated by byte-comparison are pinned eol=lf", () => {
  for (const path of BYTE_COMPARED_ARTIFACTS) {
    it(`${path} is pinned eol=lf in .gitattributes`, () => {
      expect(effectiveEol(path)).toBe("lf");
    });

    it(`${path} has no CRLF in the working tree`, () => {
      // The symptom itself, on the machine that suffers it. A no-op on
      // LF-native platforms — the check-attr assertion above is what carries
      // the guarantee on CI.
      expect(readFileSync(join(REPO_ROOT, path), "utf-8")).not.toContain("\r\n");
    });
  }
});
