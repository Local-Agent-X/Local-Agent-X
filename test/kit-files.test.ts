// A kit script that imports a file the kit does not ship dies on its import in
// every project (typescript-api.mjs, 2026-10-19: added to the skill, imported
// by code-size.mjs, never vendored). The scripts a project gets are read from
// the sync's own record (kit-files.ts KIT_SCRIPTS), so this holds every import
// between them to that one list.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_SCRIPTS } from "../src/app-scaffold/kit-files.js";

const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app-scaffold", "kit");

describe("the structure kit", () => {
  it("ships every script its scripts import", () => {
    const shipped = new Set(KIT_SCRIPTS);
    const missing: string[] = [];
    for (const script of KIT_SCRIPTS) {
      const source = readFileSync(join(KIT_DIR, script), "utf-8");
      for (const [, target] of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
        if (!shipped.has(target)) missing.push(`${script} imports ./${target}`);
      }
    }
    expect(KIT_SCRIPTS).toContain("check-structure.mjs");
    expect(missing).toEqual([]);
  });
});
