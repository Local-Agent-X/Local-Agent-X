import { describe, it, expect } from "vitest";
import {
  renderPerBuildContext,
  renderBuilderPrompt,
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
