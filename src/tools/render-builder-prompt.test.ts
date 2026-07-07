import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderPerBuildContext,
  renderBuilderPrompt,
  readUpdateContextFiles,
  UPDATE_CONTEXT_FILE_CAP,
  type BuilderPromptInput,
} from "./render-builder-prompt.js";

/** Minimal valid per-build input; the prompt is the only field the design
 *  seam keys off, so tests vary just that. */
function inputFor(prompt: string): BuilderPromptInput {
  return {
    appName: "demo",
    prompt,
    appDir: "/tmp/demo",
    appUrl: "http://127.0.0.1:7007/apps/demo/index.html",
    isUpdate: false,
    contextFiles: [],
    assetFiles: [],
  };
}

describe("renderPerBuildContext — design-brief seam", () => {
  it("flows fintech archetype guidance for a fintech trading dashboard prompt", () => {
    const out = renderPerBuildContext(inputFor("a fintech trading dashboard"));
    // Archetype-specific header + a phrase unique to the fintech brief.
    expect(out).toContain("DESIGN DIRECTION — Fintech & Trust");
    expect(out).toContain("gain/loss semantics");
    // Prove specificity: the fintech render must NOT carry the portfolio brief.
    expect(out).not.toContain("DESIGN DIRECTION — Creative Portfolio");
  });

  it("flows creative-portfolio guidance for a photographer portfolio prompt", () => {
    const out = renderPerBuildContext(inputFor("photographer portfolio"));
    expect(out).toContain("DESIGN DIRECTION — Creative Portfolio");
    // A layout phrase distinctive to the portfolio archetype.
    expect(out).toContain("masonry grid");
    // Different archetype than the fintech case above — specificity actually flows.
    expect(out).not.toContain("DESIGN DIRECTION — Fintech & Trust");
  });

  it("includes the universal anti-pattern constraints on every build", () => {
    for (const prompt of [
      "a fintech trading dashboard",
      "photographer portfolio",
      "some app with no matching archetype keywords",
      "",
    ]) {
      const out = renderPerBuildContext(inputFor(prompt));
      expect(out).toContain("UNIVERSAL DESIGN RULES");
      expect(out).toContain("prefers-reduced-motion");
      expect(out).toContain("4.5:1");
    }
  });

  it("scopes the archetype brief to CREATE — an UPDATE keeps only the universal anti-patterns", () => {
    // An update's prompt is a change instruction, not the app description;
    // classifying it would inject a mismatched archetype (fintech into a health
    // app). The archetype header must be suppressed, the anti-patterns kept.
    const update = renderPerBuildContext({
      ...inputFor("add a payments checkout page"),
      isUpdate: true,
    });
    expect(update).not.toContain("DESIGN DIRECTION");
    expect(update).toContain("prefers-reduced-motion");
    expect(update).toContain("4.5:1");

    // Same-ish fintech description on a CREATE still gets the archetype brief.
    const create = renderPerBuildContext(inputFor("a fintech payments checkout app"));
    expect(create).toContain("DESIGN DIRECTION — Fintech & Trust");
  });

  it("still emits the APP_READY sentinel after the design guidance", () => {
    const out = renderPerBuildContext(inputFor("a fintech trading dashboard"));
    const designIdx = out.indexOf("UNIVERSAL DESIGN RULES");
    const readyIdx = out.indexOf("APP_READY:");
    expect(designIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeGreaterThan(designIdx);
  });
});

describe("renderBuilderPrompt — legacy path carries the same design seam", () => {
  it("includes the archetype brief and anti-patterns for the CLI-subprocess prompt", () => {
    const out = renderBuilderPrompt(inputFor("a fintech trading dashboard"));
    expect(out).toContain("DESIGN DIRECTION — Fintech & Trust");
    expect(out).toContain("UNIVERSAL DESIGN RULES");
  });
});

describe("readUpdateContextFiles — full-fidelity update context", () => {
  const tempDirs: string[] = [];
  function makeAppDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "update-ctx-test-"));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length > 0) {
      try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("seeds a 15KB index.html WHOLE — the old 3KB slice cut a real game off inside its stylesheet [regression]", () => {
    const dir = makeAppDir();
    // Same shape as the live failure: big <style> block first, game logic last.
    const logic = "function updatePlayer(dt) { /* the code the fixer must see */ }";
    const html = `<!doctype html><style>${"a".repeat(14_000)}</style><script>${logic}</script>`;
    writeFileSync(join(dir, "index.html"), html);
    const blocks = readUpdateContextFiles(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("=== index.html (complete) ===");
    expect(blocks[0]).toContain(logic);
    expect(blocks[0]).not.toContain("TRUNCATED");
  });

  it("truncates past the cap LOUDLY — says how much is missing and orders a full read", () => {
    const dir = makeAppDir();
    writeFileSync(join(dir, "index.html"), "x".repeat(UPDATE_CONTEXT_FILE_CAP + 5_000));
    const blocks = readUpdateContextFiles(dir);
    expect(blocks[0]).toContain(`TRUNCATED — showing first ${UPDATE_CONTEXT_FILE_CAP}`);
    expect(blocks[0]).toContain("READ the full file");
  });
});

describe("renderPerBuildContext — update repair rules", () => {
  it("an UPDATE carries read-first + rewrite authority; a CREATE does not", () => {
    const update = renderPerBuildContext({ ...inputFor("fix the broken renderer"), isUpdate: true });
    expect(update).toContain("READ it in full");
    expect(update).toContain("REWRITE the affected file");
    const create = renderPerBuildContext(inputFor("a maze game"));
    expect(create).not.toContain("REWRITE the affected file");
  });
});
