import { describe, it, expect } from "vitest";
import { DESIGN_ANTI_PATTERNS, selectDesignBrief } from "./design-brief.js";

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
  it("names the archetype and carries domain-appropriate guidance (fintech)", () => {
    const { archetypeName, brief } = selectDesignBrief("fintech dashboard for traders");
    expect(archetypeName).toBe("Fintech & Trust");
    expect(brief).toContain("Fintech & Trust");
    expect(brief).toMatch(/trust/i);
    // Every brief carries the full direction (style, palette, typography, motion, layout).
    expect(brief).toMatch(/Typography:/);
    expect(brief).toMatch(/Layout & hierarchy:/);
  });

  it("carries product-forward guidance for a storefront", () => {
    const { brief } = selectDesignBrief("online store for handmade candles");
    expect(brief).toMatch(/product/i);
    expect(brief.length).toBeGreaterThan(0);
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
