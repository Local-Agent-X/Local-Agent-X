import { describe, expect, it, vi } from "vitest";
import { basePartSlug, basePromptSections, loadSystemPrompt } from "../config-loader.js";
import { CODE_MODE_PART, basePromptForMode, promptPartInMode } from "./prompt-mode.js";
import { createSystemPromptBuilder } from "./system-prompt-builder.js";

// A real App Map needs a generated manifest on disk; a stand-in shows which
// modes carry the section at all.
vi.mock("../manifest-generator/index.js", () => ({ getManifestSummary: () => "## App Map (stand-in)" }));

const file = loadSystemPrompt();
const slugs = basePromptSections(file).map((part) => basePartSlug(part.id));

describe("prompt parts per chat mode, against the shipped config/system-prompt.md", () => {
  it("the coding How to work exists and only a code session carries it", () => {
    expect(slugs).toContain(CODE_MODE_PART);
    expect(promptPartInMode(CODE_MODE_PART, "code")).toBe(true);
    expect(promptPartInMode(CODE_MODE_PART, "chat")).toBe(false);
  });

  it("a chat carries every other part, unchanged", () => {
    for (const slug of slugs.filter((s) => s !== CODE_MODE_PART)) expect(promptPartInMode(slug, "chat"), slug).toBe(true);
  });

  // Every part code mode drops must be a real heading: a renamed heading would
  // otherwise slip silently back into every code session.
  it("every part a code session leaves out is a heading of the shipped prompt", () => {
    const leftOut = slugs.filter((slug) => !promptPartInMode(slug, "code"));
    expect(leftOut.sort()).toEqual([
      "apps-pages", "browser", "delegation", "how-to-control-your-own-app", "how-to-work", "memory",
      "personality", "self-modification", "self-repair-and-self-extension",
    ]);
  });

  it("a code session keeps the safety and identity parts and coding discipline", () => {
    for (const slug of ["preamble", "identity", "core-rules", "workspace-security", "coding-discipline"]) {
      expect(promptPartInMode(slug, "code"), slug).toBe(true);
    }
  });

  it("a code session's base prompt is well under half a chat's", () => {
    expect(basePromptForMode(file, "code").length).toBeLessThan(basePromptForMode(file, "chat").length / 2);
  });

  it("the builder renders exactly the mode's parts, in file order", async () => {
    for (const mode of ["chat", "code"] as const) {
      const built = await createSystemPromptBuilder({ basePrompt: file, providerHint: "", mode }).buildWithTelemetry();
      const core = built.renderedSections.filter((s) => s.id.startsWith("core-identity/")).map((s) => s.text).join("");
      expect(core, mode).toBe(basePromptForMode(file, mode));
    }
  });

  it("a code session leaves out the App Map, a chat keeps it", async () => {
    const ids = async (mode: "chat" | "code") =>
      (await createSystemPromptBuilder({ basePrompt: file, providerHint: "", mode }).buildWithTelemetry()).renderedSections.map((s) => s.id);
    expect(await ids("chat")).toContain("app-manifest");
    expect(await ids("code")).not.toContain("app-manifest");
  });
});
