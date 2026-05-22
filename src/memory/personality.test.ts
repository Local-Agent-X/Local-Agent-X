/**
 * dedupeProfileMarkdown — collapses duplicate top-level blocks in profile
 * markdown files (USER.md / IDENTITY.md / HEART.md). Background: pre-fix,
 * every memory_update_profile `append` of a fresh "# About Me" block left
 * the older one in place, so a corrected name would persist alongside the
 * stale one, and the model saw multiple `Name:` lines and either re-asked
 * the identity question or addressed the user by an outdated value.
 */
import { describe, it, expect } from "vitest";
import { dedupeProfileMarkdown } from "./personality.js";

describe("dedupeProfileMarkdown", () => {
  it("is a no-op for a clean single-block file", () => {
    const input =
      "# About Me\n\n- Name: Alex\n- Location:\n\n## Family & People\n\n## Current Projects\n";
    expect(dedupeProfileMarkdown(input)).toBe(input);
  });

  it("returns empty/whitespace-only input unchanged", () => {
    expect(dedupeProfileMarkdown("")).toBe("");
    expect(dedupeProfileMarkdown("   \n  \n")).toBe("   \n  \n");
  });

  it("collapses stacked duplicate top-level blocks into one", () => {
    const input = [
      "# About Me",
      "",
      "- Name: Alex",
      "- Location:",
      "",
      "# About Me",
      "",
      "- Name:",
      "- Location:",
      "",
      "# About Me",
      "",
      "- Name: Gaylord Faucker",
      "- Location:",
    ].join("\n");

    const out = dedupeProfileMarkdown(input);
    const aboutMeCount = out.split("\n").filter((l) => /^#\s+About Me\s*$/.test(l)).length;
    expect(aboutMeCount).toBe(1);
  });

  it("preserves the real name when later blocks left it empty", () => {
    const input = [
      "# About Me",
      "",
      "- Name: Alex",
      "",
      "# About Me",
      "",
      "- Name:",
    ].join("\n");
    const out = dedupeProfileMarkdown(input);
    expect(out).toContain("- Name: Alex");
    expect(out.match(/- Name:/g)?.length).toBe(1);
  });

  it("takes the latest non-empty value when the user corrects themselves", () => {
    const input = [
      "# About Me",
      "",
      "- Name: Alice",
      "",
      "# About Me",
      "",
      "- Name: Bob",
    ].join("\n");
    const out = dedupeProfileMarkdown(input);
    expect(out).toContain("- Name: Bob");
    expect(out).not.toContain("- Name: Alice");
  });

  it("merges subsections across duplicate blocks, latest wins", () => {
    const input = [
      "# About Me",
      "",
      "- Name: Alex",
      "",
      "## Current Projects",
      "old projects",
      "",
      "# About Me",
      "",
      "- Name: Alex",
      "",
      "## Current Projects",
      "new projects",
      "",
      "## Family & People",
      "list",
    ].join("\n");
    const out = dedupeProfileMarkdown(input);
    expect(out).toContain("new projects");
    expect(out).not.toContain("old projects");
    expect(out).toContain("## Family & People");
  });

  it("preserves heading insertion order on first appearance", () => {
    const input = [
      "# About Me",
      "- Name: Alex",
      "# Agent Identity",
      "- Name: NutraGod",
      "# About Me",
      "- Name: Alex",
    ].join("\n");
    const out = dedupeProfileMarkdown(input);
    const aboutAt = out.indexOf("# About Me");
    const idAt = out.indexOf("# Agent Identity");
    expect(aboutAt).toBeGreaterThanOrEqual(0);
    expect(idAt).toBeGreaterThan(aboutAt);
  });

  it("handles the real corrupted USER.md shape", () => {
    const input = [
      "# About Me",
      "# About Me",
      "",
      "- Name: Alex",
      "- Location:",
      "- Job/Role:",
      "- Communication style: casual/direct",
      "## Family & People",
      "",
      "## Current Projects",
      "## # About Me",
      "# About Me",
      "",
      "- Name:",
      "- Location:",
      "",
      "# About Me",
      "",
      "- Name: Gaylord Faucker",
      "- Location:",
      "",
      "# About Me",
      "",
      "- Name: John Conner",
    ].join("\n");

    const out = dedupeProfileMarkdown(input);
    const topAbouts = out.split("\n").filter((l) => /^#\s+About Me\s*$/.test(l)).length;
    expect(topAbouts).toBe(1);
    // John Conner was the latest non-empty Name — latest-wins semantics keep it.
    // (User-side correction needs to come through ANOTHER write — this just
    // ensures we don't multiply blocks; it doesn't invent intent.)
    expect(out).toContain("- Name: John Conner");
  });
});
