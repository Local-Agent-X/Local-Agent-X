import { describe, expect, it } from "vitest";
import {
  basePromptSections,
  classifySystemPromptPart,
  loadSystemPrompt,
  loadSystemPromptSections,
  splitSystemPromptSections,
} from "./config-loader.js";

// The base prompt is ONE agent-editable file that the builder emits as one
// section per `## ` heading. These pin the two properties that make that safe:
// the parts join back to the file byte-for-byte (the prompt-cache prefix is
// unchanged), and every heading in the shipped file has a deliberate budget
// class (an unknown heading is tuning — shed first — and logged, not silent).

describe("splitSystemPromptSections", () => {
  it("round-trips config/system-prompt.md byte-for-byte through loadSystemPromptSections", () => {
    const whole = loadSystemPrompt();
    expect(whole.length).toBeGreaterThan(0);
    const parts = loadSystemPromptSections();
    expect(parts.map((part) => part.text).join("")).toBe(whole);
    // Every part but the preamble starts on its own heading line.
    for (const part of parts.slice(1)) expect(part.text.startsWith(`## ${part.heading}`)).toBe(true);
    expect(parts[0].heading).toBe("");
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps CRLF, trailing blank lines and `###` sub-headings inside their part", () => {
    const text = "intro\r\n\r\n## One\r\nbody\r\n### not a split\r\n\r\n## Two (note)\r\nmore";
    const parts = splitSystemPromptSections(text);
    expect(parts.map((part) => part.heading)).toEqual(["", "One", "Two (note)"]);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts[1].text).toBe("## One\r\nbody\r\n### not a split\r\n\r\n");
  });

  it("emits no preamble part when the text opens on a heading, and nothing for empty text", () => {
    expect(splitSystemPromptSections("## Only\nx").map((part) => part.heading)).toEqual(["Only"]);
    expect(splitSystemPromptSections("")).toEqual([]);
    expect(splitSystemPromptSections("no headings at all")).toEqual([{ heading: "", text: "no headings at all" }]);
  });
});

describe("classifySystemPromptPart", () => {
  it("classifies every heading of the shipped prompt on purpose — none fall through to the unknown default", () => {
    const expected: Record<string, string> = {
      "preamble": "identity",
      "how-to-control-your-own-app": "navigation",
      "identity": "identity",
      "how-to-work": "tuning",
      "coding-discipline": "tuning",
      "delegation": "tuning",
      "background-operations": "navigation",
      "core-rules": "safety",
      "browser": "tuning",
      "apps-pages": "navigation",
      "memory": "navigation",
      "personality": "identity",
      "self-modification": "tuning",
      "self-repair-and-self-extension": "tuning",
      "workspace-security": "safety",
    };
    const seen = loadSystemPromptSections().map((part) => classifySystemPromptPart(part.heading));
    expect(Object.fromEntries(seen.map(({ slug, priority }) => [slug, priority]))).toEqual(expected);
    // Both never-shed classes are present, and the safety class is small: the
    // whole point of the split is that safety ≪ the file.
    expect(seen.some(({ priority }) => priority === "safety")).toBe(true);
    expect(seen.some(({ priority }) => priority === "identity")).toBe(true);
  });

  it("slugs the heading up to its first parenthetical or dash qualifier", () => {
    expect(classifySystemPromptPart("Apps & Pages — in-app vs external").slug).toBe("apps-pages");
    expect(classifySystemPromptPart("Self-modification (config/ directory)").slug).toBe("self-modification");
    expect(classifySystemPromptPart("Memory — relational, not transactional").slug).toBe("memory");
    expect(classifySystemPromptPart("").slug).toBe("preamble");
  });

  it("treats an unknown heading as tuning, the first class shed", () => {
    expect(classifySystemPromptPart("Brand New Guidance An Agent Added")).toEqual({
      slug: "brand-new-guidance-an-agent-added",
      priority: "tuning",
    });
  });
});

describe("basePromptSections", () => {
  it("derives policy from class: safety and identity required, everything else degradable", () => {
    const sections = basePromptSections(
      "You are X.\n## Core rules\nr\n## Browser\nb\n## Apps & Pages\na\n## Personality\np\n## Unknown thing\nu",
    );
    expect(sections.map(({ id, priority, policy, type }) => ({ id, priority, policy, type }))).toEqual([
      { id: "core-identity/preamble", priority: "identity", policy: "required", type: "static" },
      { id: "core-identity/core-rules", priority: "safety", policy: "required", type: "static" },
      { id: "core-identity/browser", priority: "tuning", policy: "degradable", type: "static" },
      { id: "core-identity/apps-pages", priority: "navigation", policy: "degradable", type: "static" },
      { id: "core-identity/personality", priority: "identity", policy: "required", type: "static" },
      { id: "core-identity/unknown-thing", priority: "tuning", policy: "degradable", type: "static" },
    ]);
    expect(sections.map((section) => section.label)).toEqual([
      "System Prompt", "Core rules", "Browser", "Apps & Pages", "Personality", "Unknown thing",
    ]);
  });

  it("gives a repeated heading a numbered id instead of tripping the builder's duplicate guard", () => {
    const ids = basePromptSections("## Browser\na\n## Browser\nb\n## Browser (again)\nc").map((s) => s.id);
    expect(ids).toEqual(["core-identity/browser", "core-identity/browser-2", "core-identity/browser-3"]);
  });
});
