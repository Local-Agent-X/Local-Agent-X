// Vendor skill packs write `description` as a YAML block (`>-`, `|`) or a plain
// value continued on indented lines. Read as one line, those became the literal
// ">-", and the suggestion nudge — which matches on description words — never
// fired for Stripe, Firebase, Neon or AWS skills.
import { describe, it, expect } from "vitest";
import { parseSkillMd } from "./skill-md-parser.js";

const parse = (frontmatter: string) =>
  parseSkillMd(`---\n${frontmatter}\n---\n# Body\n\nDo the thing.\n`, { source: { type: "bundled" }, fallbackName: "x" })!;

describe("SKILL.md frontmatter", () => {
  it("a folded block (>-) joins its lines; a blank line starts a new one", () => {
    const p = parse("name: stripe-best-practices\ndescription: >-\n  Guides Stripe integration decisions\n  across billing and Connect.\n\n  Use when building payments.\nlicense: MIT");
    expect(p.description).toBe("Guides Stripe integration decisions across billing and Connect.\nUse when building payments.");
    expect(p.source?.license).toBe("MIT");
  });

  it("a literal block (|) keeps its line breaks", () => {
    expect(parse("name: a\ndescription: |\n  line one\n  line two").description).toBe("line one\nline two");
  });

  it("a plain value continued on indented lines is read whole", () => {
    expect(parse("name: vercel-composition-patterns\ndescription:\n  React composition patterns that scale.\n  Use when refactoring components.")
      .description).toBe("React composition patterns that scale. Use when refactoring components.");
  });

  it("a nested map is not mistaken for text, and the keys after it still parse", () => {
    const p = parse("name: comp\ndescription: One line.\nmetadata:\n  author: vercel\n  version: '1.0.0'\nallowed-tools: [bash]");
    expect(p.description).toBe("One line.");
    expect(p.allowedTools).toEqual(["bash"]);
  });

  it("one-line values, inline lists and dash lists are unchanged", () => {
    const p = parse("name: s\ndescription: \"Quoted one-liner\"\ntriggers: [deploy, ship it]\ntags:\n  - a\n  - b");
    expect(p.description).toBe("Quoted one-liner");
    expect(p.triggers).toEqual(["deploy", "ship it"]);
  });
});
