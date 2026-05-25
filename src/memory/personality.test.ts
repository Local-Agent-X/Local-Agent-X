/**
 * dedupeProfileMarkdown — collapses duplicate top-level blocks in profile
 * markdown files (USER.md / IDENTITY.md / HEART.md). Background: pre-fix,
 * every memory_update_profile `append` of a fresh "# About Me" block left
 * the older one in place, so a corrected name would persist alongside the
 * stale one, and the model saw multiple `Name:` lines and either re-asked
 * the identity question or addressed the user by an outdated value.
 */
import { describe, it, expect } from "vitest";
import { dedupeProfileMarkdown, setUserScalarField } from "./personality.js";

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

  it("handles single-block files with duplicate subsections (the actual corruption pattern)", () => {
    // Pre-fix shape: one top-level # About Me with a stale "Name:" line,
    // then later appends piled on extra `## Communication style` and
    // `## Family & People` subsections — sometimes prefixed with the
    // garbage "## ## Heading" double-marker. The old fast-path bailed
    // on single-top-heading files and let the duplicates persist.
    const input = [
      "# About Me",
      "",
      "- Name: Daddy Fag",
      "- Location:",
      "",
      "## ## Communication style",
      "## Communication style",
      "- Prefers to be addressed as \"Daddy\".",
      "",
      "## ## Family & People## Family & People",
      "- Preferred form of address and full name: \"Daddy Fag\".",
      "## Family & People",
      "- Preferred form of address: \"Mr. Fag\".",
    ].join("\n");

    const out = dedupeProfileMarkdown(input);
    expect((out.match(/^##\s+Communication style\s*$/gm) ?? []).length).toBe(1);
    expect((out.match(/^##\s+Family & People\s*$/gm) ?? []).length).toBe(1);
    // The double-prefix garbage ("## ## Heading") should be normalized away
    expect(out).not.toMatch(/^##\s+##\s+/m);
  });
});

describe("setUserScalarField", () => {
  it("rewrites an existing scalar in place — replaces the stale value", () => {
    const input = "# About Me\n\n- Name: Daddy Fag\n- Location:\n";
    const out = setUserScalarField(input, "Name", "Alex");
    expect(out).toContain("- Name: Alex");
    expect(out).not.toContain("Daddy Fag");
    // No duplicate Name bullet added.
    expect((out.match(/^-\s+Name:/gm) ?? []).length).toBe(1);
  });

  it("matches case-insensitively so 'name' and 'NAME' update the same line", () => {
    const input = "# About Me\n\n- Name: Old\n";
    expect(setUserScalarField(input, "name", "New")).toContain("- Name: New");
    expect(setUserScalarField(input, "NAME", "Newer")).toContain("- Name: Newer");
  });

  it("adds a new bullet under the heading when the field doesn't exist yet", () => {
    const input = "# About Me\n\n- Name: Alex\n";
    const out = setUserScalarField(input, "Pronouns", "he/him");
    expect(out).toContain("- Name: Alex");
    expect(out).toContain("- Pronouns: he/him");
  });

  it("creates a minimal file when the input is empty/blank", () => {
    expect(setUserScalarField("", "Name", "Alex")).toBe("# About Me\n\n- Name: Alex\n");
    expect(setUserScalarField("   \n", "Name", "Alex")).toBe("# About Me\n\n- Name: Alex\n");
  });

  it("clears the field when value is empty (preserves the bullet)", () => {
    const input = "# About Me\n\n- Name: Alex\n";
    const out = setUserScalarField(input, "Name", "");
    expect(out).toContain("- Name:");
    expect(out).not.toContain("Alex");
  });

  it("ignores trailing duplicates — first match wins, dedupe later collapses the rest", () => {
    // Replicates the post-corruption shape where the same field appeared
    // multiple times. Our pass rewrites the first; dedupeProfileMarkdown
    // (called from the tool funnel) collapses the trailing copies.
    const input = "# About Me\n\n- Name: Daddy Fag\n\n## Family & People\n- Name: Mr. Fag\n";
    const out = setUserScalarField(input, "Name", "Alex");
    const firstLine = out.split("\n").find((l) => l.startsWith("- Name:"));
    expect(firstLine).toBe("- Name: Alex");
  });
});
