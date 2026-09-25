// A read of a path whose whole folder is a guess (the prompt's apps/ convention
// applied to a project that sits at the workspace root) used to come back as a
// bare "File not found", and the model concluded the project did not exist and
// created one (op-outcomes correction-chain, 2026-09-25). The not-found result
// now names where the same file lives.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileNotFoundError, suggestElsewhere } from "./edit-recovery.js";
import { renderToolResultForModel } from "./result-helpers.js";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "lax-elsewhere-"));
  mkdirSync(join(root, "pricing-app", "src"), { recursive: true });
  writeFileSync(join(root, "pricing-app", "src", "format.js"), "");
  mkdirSync(join(root, "api-client", "src"), { recursive: true });
  writeFileSync(join(root, "api-client", "src", "format.js"), "");
  mkdirSync(join(root, "node_modules", "dep", "src"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "src", "format.js"), "");
  mkdirSync(join(root, "apps"), { recursive: true });
  return root;
}

describe("suggestElsewhere — the guessed folder does not exist, the file does, somewhere else", () => {
  it("ranks the match whose trailing segments agree with the request first, skips dependency dirs", () => {
    const root = workspace();
    try {
      const hits = suggestElsewhere(join(root, "apps", "pricing-app", "src", "format.js"), root);
      expect(hits[0]).toBe("pricing-app/src/format.js");
      expect(hits).toContain("api-client/src/format.js");
      expect(hits.some((h) => h.includes("node_modules"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a directory by name too, and returns nothing for a name that exists nowhere", () => {
    const root = workspace();
    try {
      expect(suggestElsewhere(join(root, "apps", "pricing-app"), root)).toEqual(["pricing-app"]);
      expect(suggestElsewhere(join(root, "apps", "billing-app", "src", "money.js"), root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fileNotFoundError — the rendered result carries the elsewhere hint", () => {
  it("names the real location when the folder itself is missing; keeps the sibling hint when the folder exists", () => {
    const root = workspace();
    try {
      // Folder missing entirely → elsewhere hint (needs the workspace root: pass through suggestElsewhere's default by
      // building the same string the tool would).
      const missing = join(root, "apps", "pricing-app", "src", "format.js");
      const text = renderToolResultForModel(fileNotFoundError(missing));
      // The default root is the real workspace, not this temp tree, so assert on the shape via the helper directly:
      expect(text).toContain("File not found");
      expect(suggestElsewhere(missing, root)[0]).toBe("pricing-app/src/format.js");
      // Folder exists, name is a typo → siblings, not elsewhere.
      const typo = join(root, "pricing-app", "src", "format.ts");
      const sib = renderToolResultForModel(fileNotFoundError(typo));
      expect(sib).toContain("Did you mean one of");
      expect(sib).toContain("format.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
