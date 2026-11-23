import { describe, expect, it, vi } from "vitest";
import { basePartSlug, basePromptSections, loadSystemPrompt } from "../config-loader.js";
import { CODE_MODE_PART, ONE_STEP_AWAY_PART, basePromptForMode, oneStepAwayText, promptPartInMode } from "./prompt-mode.js";
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

  // A shorter prompt must not make a capability unknown. A code session asked
  // to "put the app in light mode" had no word of the app it runs inside and
  // never loaded `setting` (2026-11-22).
  it("a code session names what each left-out part did, one tool_search away", async () => {
    const step = oneStepAwayText();
    for (const tool of ["setting", "browser", "memory_search", "build_app", "self_edit", "connector_create"]) expect(step, tool).toContain(`\`${tool}\``);
    expect(step).toContain("tool_search");
    expect(step).toContain("Local Agent X itself");
    expect(basePromptForMode(file, "code").endsWith(step)).toBe(true);
    expect(basePromptForMode(file, "chat")).not.toContain("## One step away");
    const ids = (await createSystemPromptBuilder({ basePrompt: file, providerHint: "", mode: "code" }).buildWithTelemetry()).renderedSections.map((s) => s.id);
    expect(ids).toContain(`core-identity/${ONE_STEP_AWAY_PART}`);
  });

  // Each named tool is a real one: a renamed tool would leave the line pointing nowhere.
  it("every tool the One step away part names is registered", async () => {
    const { TOOL_POLICIES } = await import("../tool-policy/tool-policies.data.js");
    const named = [...oneStepAwayText().matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => n !== "tool_search");
    for (const name of named) expect(Object.hasOwn(TOOL_POLICIES, name), name).toBe(true);
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

  // The coding rules are the last parts a small window gives up in a code
  // session: their own classes (tuning, navigation) shed them first, ahead of
  // recalled personal facts.
  it("a code session sheds the coding rules last, a chat under their own classes", async () => {
    const { applyCapabilityAwarePromptDegradation } = await import("./prompt-degradation.js");
    const classOf = async (mode: "chat" | "code", id: string) => {
      const builder = createSystemPromptBuilder({ basePrompt: file, providerHint: "", mode });
      return builder.getSectionPolicy().find((s) => s.id === id)?.priority;
    };
    expect(await classOf("code", "core-identity/coding-discipline")).toBe("facts");
    expect(await classOf("code", `core-identity/${CODE_MODE_PART}`)).toBe("facts");
    expect(await classOf("chat", "core-identity/coding-discipline")).toBe("tuning");

    // A window too small for the whole prompt: recalled memory goes before the coding rules do.
    const built = await createSystemPromptBuilder({
      basePrompt: file, providerHint: "", mode: "code", contextBlock: "<user_profile>\n" + "fact ".repeat(4000) + "\n</user_profile>",
    }).buildWithTelemetry();
    const full = built.renderedSections.reduce((sum, s) => sum + s.measurement.estimatedTokens, 0);
    const memory = built.renderedSections.find((s) => s.id === "context-block")!.measurement.estimatedTokens;
    const window = Math.ceil((full - memory / 2) / 0.35);
    const shed = applyCapabilityAwarePromptDegradation(built.renderedSections, {
      runtimeId: "test", model: "small", contextWindow: window, tools: { advertised: true, verified: true, rejectsTools: false },
    } as never);
    const kept = shed.sections.map((s) => s.id);
    expect(kept).not.toContain("context-block");
    expect(kept).toContain("core-identity/coding-discipline");
    expect(kept).toContain(`core-identity/${CODE_MODE_PART}`);
  });

  it("a code session leaves out the App Map, a chat keeps it", async () => {
    const ids = async (mode: "chat" | "code") =>
      (await createSystemPromptBuilder({ basePrompt: file, providerHint: "", mode }).buildWithTelemetry()).renderedSections.map((s) => s.id);
    expect(await ids("chat")).toContain("app-manifest");
    expect(await ids("code")).not.toContain("app-manifest");
  });
});
