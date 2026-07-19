import { describe, expect, it } from "vitest";
import { measurePromptSection } from "../prompt-telemetry.js";
import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import {
  appendSystemPromptSection,
  SystemPromptBuilder,
  type RenderedPromptSection,
} from "./system-prompt-builder.js";
import { applyCapabilityAwarePromptDegradation } from "./prompt-degradation.js";

function section(
  id: string,
  policy: RenderedPromptSection["policy"],
  text: string,
  type: RenderedPromptSection["type"] = "dynamic",
): RenderedPromptSection {
  return { id, label: id, type, policy, text, measurement: measurePromptSection(id, type, text) };
}

function profile(contextWindow: number | null, tier: LocalModelCapabilityProfile["tier"] = "medium") {
  return {
    runtimeId: "ollama@127.0.0.1:11434",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "test-local-model",
    tier,
    maxTools: tier === "weak" ? 8 : 24,
    contextWindow,
    tools: { advertised: null, verified: null, rejectsTools: false },
  } satisfies LocalModelCapabilityProfile;
}

const REQUIRED_IDS = [
  "core-identity",
  "runtime-context",
  "agents-md",
  "provider-hint",
  "tool-guidance",
  "recall-reflex",
  "system-prompt-override",
  "file-access",
  "provider-rider",
  "model-family-rider",
  "turn-directive",
  "file-attachments",
  "security-canary",
  "tool-call-required",
  "system-history",
];

function constrainedFixture(): RenderedPromptSection[] {
  return [
    section("core-identity", "required", "identity", "static"),
    section("app-manifest", "degradable", "manifest:" + "m".repeat(14_000), "static"),
    section("runtime-context", "required", "runtime", "static"),
    section("agents-md", "required", "rules", "static"),
    section("provider-hint", "required", "provider", "static"),
    section("tool-guidance", "required", "tools", "static"),
    section("recall-reflex", "required", "recall", "static"),
    section("system-prompt-override", "required", "override", "static"),
    section("smart-context", "degradable", "smart:" + "s".repeat(8_000)),
    section("turn-directive", "required", "build"),
    section("file-access", "required", "file-policy"),
    section("provider-rider", "required", "provider-rider"),
    section("model-family-rider", "required", "model-rider"),
    section("file-attachments", "required", "attachment"),
    section("security-canary", "required", "canary"),
    section("tool-call-required", "required", "correction"),
    section("system-history", "required", "folded-history"),
  ];
}

describe("capability-aware prompt degradation", () => {
  it("keeps cloud and capable local prompts byte-for-byte unchanged", () => {
    const sections = constrainedFixture();
    const original = sections.map((item) => item.text).join("");

    const cloud = applyCapabilityAwarePromptDegradation(sections, null);
    const capable = applyCapabilityAwarePromptDegradation(sections, profile(65_536));

    expect(cloud.prompt).toBe(original);
    expect(capable.prompt).toBe(original);
    expect(cloud.sections).toEqual(sections);
    expect(capable.sections).toEqual(sections);
    expect(cloud.telemetry).toMatchObject({ mode: "full", reason: "not-local-target" });
    expect(capable.telemetry).toMatchObject({ mode: "full", reason: "capability-not-constrained" });
  });

  it("omits only declared degradable sections and preserves every required byte and order", () => {
    const sections = constrainedFixture();
    const result = applyCapabilityAwarePromptDegradation(sections, profile(8_192));
    const includedIds = result.sections.map((item) => item.id);

    expect(result.telemetry.mode).toBe("constrained-local");
    expect(result.telemetry.degradedSections.map((item) => item.id)).toEqual([
      "app-manifest",
    ]);
    expect(result.telemetry.degradedSections.every(({ id }) =>
      sections.find((item) => item.id === id)?.policy === "degradable",
    )).toBe(true);
    expect(includedIds).toEqual(expect.arrayContaining(REQUIRED_IDS));
    expect(result.prompt).toBe(result.sections.map((item) => item.text).join(""));
    for (const required of sections.filter((item) => item.policy === "required")) {
      expect(result.prompt).toContain(required.text);
    }
  });

  it("bounds unknown local evidence conservatively without claiming capability support", () => {
    const sections = constrainedFixture();
    const result = applyCapabilityAwarePromptDegradation(sections, profile(null));

    expect(result.telemetry).toMatchObject({
      mode: "constrained-local",
      contextEvidence: "unknown",
      toolEvidence: "unknown",
      localTarget: { contextWindow: null },
      assumedContextWindowTokens: 8_192,
      promptBudgetTokens: Math.floor(8_192 * 0.35),
    });
    expect(result.telemetry.reason).not.toBe("capability-not-constrained");
    expect(result.telemetry.degradedSections.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.telemetry)).not.toContain("manifest:");
    expect(JSON.stringify(result.telemetry)).not.toContain("folded-history");
  });

  it("is deterministic across repeated renders", () => {
    const sections = constrainedFixture();
    const first = applyCapabilityAwarePromptDegradation(sections, profile(8_192));
    const second = applyCapabilityAwarePromptDegradation(sections, profile(8_192));

    expect(second.prompt).toBe(first.prompt);
    expect(second.sections.map((item) => item.id)).toEqual(first.sections.map((item) => item.id));
    expect(second.telemetry).toEqual(first.telemetry);
  });

  it("preserves required sections appended before and after the canonical builder render", async () => {
    const built = await new SystemPromptBuilder()
      .addSection({
        id: "system-prompt-override", label: "Override", type: "static", policy: "required",
        build: () => "override",
      })
      .addSection({
        id: "app-manifest", label: "App Map", type: "static", policy: "degradable",
        build: () => "manifest:" + "m".repeat(16_000),
      })
      .addSection({
        id: "turn-directive", label: "Turn Directive", type: "dynamic", policy: "required",
        build: () => "build-directive",
      })
      .buildWithTelemetry();
    const target = {
      systemPrompt: built.prompt,
      renderedPromptSections: [...built.renderedSections],
    };
    for (const [id, text] of [
      ["file-attachments", "attachment"],
      ["security-canary", "canary"],
      ["tool-call-required", "correction"],
      ["system-history", "folded"],
    ] as const) {
      appendSystemPromptSection(target, {
        id, label: id, type: "dynamic", policy: "required", text,
      });
    }

    const result = applyCapabilityAwarePromptDegradation(target.renderedPromptSections, profile(8_192));
    expect(result.telemetry.degradedSections.map((item) => item.id)).toEqual(["app-manifest"]);
    expect(result.sections.map((item) => item.id)).toEqual([
      "system-prompt-override",
      "turn-directive",
      "file-attachments",
      "security-canary",
      "tool-call-required",
      "system-history",
    ]);
    expect(result.prompt).toBe("overridebuild-directiveattachmentcanarycorrectionfolded");
  });
});
