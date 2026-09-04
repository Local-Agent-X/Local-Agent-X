import { describe, it, expect } from "vitest";
import { DESIGN_ANTI_PATTERNS, DESIGN_CRAFT, DESIGN_TECHNIQUES, selectDesignBrief } from "./design-brief.js";

describe("selectDesignBrief — archetype classification", () => {
  const cases: Array<[string, string]> = [
    ["fintech dashboard for traders", "fintech"],
    ["a stock trading and crypto wallet app", "fintech"],
    ["portfolio site for a photographer", "creative-portfolio"],
    ["personal site to showcase my illustration work", "creative-portfolio"],
    ["online store for handmade candles", "ecommerce"],
    ["a shopping cart and checkout flow", "ecommerce"],
    ["a fitness tracking app", "health-wellness"],
    ["meditation and sleep habit tracker", "health-wellness"],
    ["CLI tool for developers", "developer-tool"],
    ["docs site with runnable API code samples", "developer-tool"],
    ["analytics dashboard with charts and KPIs", "analytics-dashboard"],
    ["landing page for a startup launch waitlist", "marketing-landing"],
    ["a B2B SaaS CRM workspace", "saas-product"],
  ];

  for (const [prompt, expectedId] of cases) {
    it(`maps "${prompt}" → ${expectedId}`, () => {
      expect(selectDesignBrief(prompt).archetypeId).toBe(expectedId);
    });
  }

  it("scores the dominant archetype when signals compete (fintech over generic dashboard)", () => {
    // "dashboard" alone reads analytics, but two fintech signals outweigh it.
    expect(selectDesignBrief("fintech dashboard for traders").archetypeId).toBe("fintech");
  });
});

describe("selectDesignBrief — neutral fallback", () => {
  it("returns the neutral default for an empty prompt", () => {
    const brief = selectDesignBrief("");
    expect(brief.archetypeId).toBe("modern-web-app");
    expect(brief.brief.length).toBeGreaterThan(0);
  });

  it("returns the neutral default for an unmatched prompt", () => {
    const brief = selectDesignBrief("qwzx flumptic zzz nonsense");
    expect(brief.archetypeId).toBe("modern-web-app");
    expect(brief.brief.length).toBeGreaterThan(0);
  });

  it("never throws on a non-string input", () => {
    // The prompt can cross a loose boundary; the never-throw contract owns it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => selectDesignBrief(undefined as any)).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(selectDesignBrief(undefined as any).archetypeId).toBe("modern-web-app");
  });
});

describe("selectDesignBrief — brief content", () => {
  it("names the archetype and carries the exact token direction (fintech)", () => {
    const { archetypeName, brief } = selectDesignBrief("fintech dashboard for traders");
    expect(archetypeName).toBe("Fintech & Trust");
    expect(brief).toContain("Fintech & Trust");
    expect(brief).toMatch(/trust/i);
    expect(brief).toMatch(/Typography:/);
    expect(brief).toMatch(/Layout & hierarchy:/);
  });

  it("is a MANDATE with EXACT committed values, not replaceable mood prose", () => {
    // The regression this file exists to prevent: vague guidance with an
    // "example, may replace" hex produced generic output. Every brief must now
    // demand exact values and carry a real palette (multiple hexes).
    for (const p of ["fintech app", "analytics dashboard", "online store", "landing page", "a plain tool"]) {
      const { brief } = selectDesignBrief(p);
      expect(brief).toMatch(/EXACT values; do not substitute/);
      // A real palette: many concrete color values, not one "example". Counted
      // by notation-agnostic match because the palettes moved from hex to oklch
      // — the invariant is "committed values", never a particular syntax.
      const colors = brief.match(/oklch\([^)]+\)|#[0-9a-fA-F]{6}\b/g) ?? [];
      expect(colors.length).toBeGreaterThanOrEqual(16);
      // Both themes ship from one definition — a light-only brief is the bug
      // that the light-dark() pairing exists to make impossible.
      expect(brief).toMatch(/color-scheme: light dark/);
      expect(brief.match(/light-dark\(/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
      // The old hedge must be gone.
      expect(brief).not.toMatch(/illustrative|may replace|never a mandate|Example (accent|anchor|CTA|statement):/i);
    }
  });

  it("carries product-forward guidance for a storefront", () => {
    const { brief } = selectDesignBrief("online store for handmade candles");
    expect(brief).toMatch(/product/i);
  });

  it("carries work-forward guidance for a portfolio", () => {
    const { brief } = selectDesignBrief("portfolio site for a photographer");
    expect(brief).toMatch(/work/i);
  });
});

describe("DESIGN_ANTI_PATTERNS — universal constraints", () => {
  it("references inline SVG icons", () => {
    expect(DESIGN_ANTI_PATTERNS).toMatch(/SVG/);
  });

  it("references visible keyboard focus states", () => {
    expect(DESIGN_ANTI_PATTERNS).toMatch(/focus/i);
  });

  it("references prefers-reduced-motion", () => {
    expect(DESIGN_ANTI_PATTERNS).toContain("prefers-reduced-motion");
  });

  it("references a minimum text contrast ratio", () => {
    expect(DESIGN_ANTI_PATTERNS).toContain("4.5:1");
  });
});

describe("DESIGN_CRAFT — the positive half (what 'polished' concretely means)", () => {
  it("is a non-empty imperative block headed CRAFT", () => {
    expect(DESIGN_CRAFT).toContain("CRAFT");
    expect(DESIGN_CRAFT.length).toBeGreaterThan(0);
  });

  it("mandates the states a happy-path build skips (empty / loading / interactive)", () => {
    expect(DESIGN_CRAFT).toMatch(/EMPTY state/);
    expect(DESIGN_CRAFT).toMatch(/LOADING state/);
    expect(DESIGN_CRAFT).toContain("HOVER, ACTIVE, FOCUS, and DISABLED");
  });

  it("covers depth, a real type ladder, spacing rhythm, and cohesion", () => {
    expect(DESIGN_CRAFT).toContain("DEPTH");
    expect(DESIGN_CRAFT).toContain("TYPE LADDER");
    expect(DESIGN_CRAFT).toContain("SPACING RHYTHM");
    expect(DESIGN_CRAFT).toContain("COHESION");
  });

  it("does NOT repeat the anti-patterns — icons/contrast/motion specifics live there, not here", () => {
    expect(DESIGN_CRAFT).not.toContain("4.5:1");
    expect(DESIGN_CRAFT).not.toContain("prefers-reduced-motion");
  });
});

describe("DESIGN_TECHNIQUES — the modern-CSS mandate", () => {
  it("names each mechanism a model will not reach for unprompted", () => {
    for (const feature of [
      "clamp(", "@container", "text-wrap: balance", "text-wrap: pretty", "65ch",
      ":focus-visible", "accent-color", ":user-invalid", "aspect-ratio",
      "scroll-margin-top", ":has(",
    ]) {
      expect(DESIGN_TECHNIQUES, `missing ${feature}`).toContain(feature);
    }
  });

  it("frames fluid sizing so it cannot fight the archetype's exact type scale", () => {
    // Both blocks reach the same build. "Make the type fluid" against "implement
    // these EXACT sizes" is a contradiction the model resolves by picking one;
    // the rule only works if it says WHICH value the stated size is.
    expect(DESIGN_TECHNIQUES).toMatch(/large-screen end/);
    expect(DESIGN_TECHNIQUES).toMatch(/body and label sizes stay exactly as given/);
  });

  it("stays clear of the craft and anti-pattern blocks it sits beside", () => {
    expect(DESIGN_TECHNIQUES).not.toContain(DESIGN_CRAFT);
    expect(DESIGN_TECHNIQUES).not.toContain(DESIGN_ANTI_PATTERNS);
  });
});
