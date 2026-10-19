// The kit's scripts are named twice: the sync's map of what to copy from the
// skill (scripts/check-kit-sync.mjs KIT_FILES) and the list a project gets
// (kit-files.ts KIT_SCRIPTS). A script added to one and not the other is not
// vendored, or not shipped, and the project's check dies on its import
// (typescript-api.mjs, 2026-10-19). These hold the two lists, and every import
// between kit scripts, to the files the kit actually has.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIT_SCRIPTS } from "../src/app-scaffold/kit-files.js";
import { KIT_DIR, KIT_FILES } from "../scripts/check-kit-sync.mjs";

const vendoredScripts = Object.keys(KIT_FILES).filter((name) => name.endsWith(".mjs")).sort();

describe("the structure kit's file lists", () => {
  it("a project gets exactly the scripts the sync vendors", () => {
    expect([...KIT_SCRIPTS].sort()).toEqual(vendoredScripts);
  });

  it("every vendored script is in the kit folder", () => {
    const present = new Set(readdirSync(KIT_DIR));
    expect(vendoredScripts.filter((name) => !present.has(name))).toEqual([]);
  });

  it("every script a kit script imports is one the kit ships", () => {
    const shipped = new Set<string>(KIT_SCRIPTS);
    const missing: string[] = [];
    for (const script of KIT_SCRIPTS) {
      const source = readFileSync(join(KIT_DIR, script), "utf-8");
      for (const [, target] of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
        if (!shipped.has(target)) missing.push(`${script} imports ./${target}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
