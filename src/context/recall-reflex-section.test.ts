import { describe, expect, it, vi } from "vitest";
import { loadSystemPrompt } from "../config-loader.js";
import { CODE_SESSION_FETCHES, recallReflexText } from "./recall-reflex-section.js";
import { createSystemPromptBuilder } from "./system-prompt-builder.js";

vi.mock("../manifest-generator/index.js", () => ({ getManifestSummary: () => "## App Map (stand-in)" }));
vi.mock("../memory/project-catalog.js", () => ({ getProjectCatalogSection: () => "## Project Catalog (stand-in)" }));

const sectionIds = async (mode: "chat" | "code") =>
  (await createSystemPromptBuilder({ basePrompt: loadSystemPrompt(), providerHint: "", memoryDir: "memory-dir", mode }).buildWithTelemetry())
    .renderedSections.map((s) => s.id);

describe("what a code session fetches instead of being handed", () => {
  // The owner's rule for trimming the code prompt (2026-11-12): only preloaded
  // content goes; whatever is no longer preloaded must name the tool that
  // fetches it, so the model takes one more step and never goes without.
  it("names a retrieval tool for each thing a code session no longer preloads", () => {
    const text = recallReflexText("code");
    // saved facts and preferences (the retained-facts dump)
    expect(text).toMatch(/saved facts and preferences: `memory_search`, or `memory_recall`/);
    // the list of other projects, and earlier chats (the project catalog)
    expect(text).toMatch(/other projects and earlier chats: `search_past_sessions`/);
    // how an unloaded tool is reached
    expect(text).toContain("`tool_search`");
  });

  it("keeps the whole recall instruction in a code session", () => {
    const chat = recallReflexText("chat");
    const code = recallReflexText("code");
    for (const line of ["## Memory-Recall Reflex", "Call `search_past_sessions` when", "A miss is not proof"]) {
      expect(chat).toContain(line);
      expect(code).toContain(line);
    }
    expect(code.endsWith(CODE_SESSION_FETCHES)).toBe(true);
  });

  it("a chat's section is the text it always was: no code-session note, the catalog still referenced", () => {
    const chat = recallReflexText("chat");
    expect(chat).not.toContain("This is a code session");
    expect(chat).toContain("Cross-reference the Project Catalog above");
    expect(recallReflexText("code")).not.toContain("Project Catalog above");
  });

  it("a code session renders the recall section and leaves the project catalog out; a chat renders both", async () => {
    const code = await sectionIds("code");
    expect(code).toContain("recall-reflex");
    expect(code).not.toContain("project-catalog");
    const chat = await sectionIds("chat");
    expect(chat).toContain("recall-reflex");
    expect(chat).toContain("project-catalog");
  });
});
