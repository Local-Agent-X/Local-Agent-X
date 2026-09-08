import { describe, expect, it } from "vitest";
import { measurePromptSection } from "../prompt-telemetry.js";
import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";
import {
  appendSystemPromptSection,
  createSystemPromptBuilder,
  SystemPromptBuilder,
  type PromptPriority,
  type RenderedPromptSection,
} from "./system-prompt-builder.js";
import { applyCapabilityAwarePromptDegradation, promptPriorityOf } from "./prompt-degradation.js";
import { loadSystemPrompt } from "../config-loader.js";

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
  it("keeps cloud prompts and local prompts within their window share byte-for-byte unchanged", () => {
    const sections = constrainedFixture();
    const original = sections.map((item) => item.text).join("");

    const cloud = applyCapabilityAwarePromptDegradation(sections, null);
    const capable = applyCapabilityAwarePromptDegradation(sections, profile(65_536));

    expect(cloud.prompt).toBe(original);
    expect(capable.prompt).toBe(original);
    expect(cloud.sections).toEqual(sections);
    expect(capable.sections).toEqual(sections);
    expect(cloud.telemetry).toMatchObject({ mode: "full", reason: "not-local-target" });
    expect(cloud.telemetry.promptBudgetTokens).toBeUndefined();
    expect(capable.telemetry).toMatchObject({
      mode: "full",
      reason: "within-prompt-budget",
      promptBudgetTokens: Math.floor(65_536 * 0.35),
    });
  });

  // Regression for 2026-09-08: a 65,536-token local model (medium tier) was
  // handed a ~37k-token system prompt because the budget only applied under an
  // absolute 32k gate. The budget is a share of the window for EVERY local
  // target, whatever its size or tier.
  function wideFixture(): RenderedPromptSection[] {
    // Sizes are chars; estimateTokens is ceil(chars / 3.5). Total ~37k tokens.
    return [
      section("core-identity", "required", "i".repeat(28_000), "static"),          // ~8,000
      section("app-manifest", "degradable", "m".repeat(35_000), "static"),         // ~10,000
      section("runtime-context", "required", "r".repeat(7_000), "static"),         // ~2,000
      section("project-catalog", "degradable", "p".repeat(21_000)),                // ~6,000
      section("context-block", "degradable", "c".repeat(14_000)),                  // ~4,000
      section("relevant-memories", "degradable", "v".repeat(10_500)),              // ~3,000
      section("memory-orchestrator", "degradable", "o".repeat(3_500)),             // ~1,000
      section("file-access", "required", "f".repeat(7_000)),                       // ~2,000
      section("learned-protocol", "degradable", "l".repeat(175)),                  // ~50
      section("security-canary", "required", "s".repeat(1_750)),                   // ~500
      section("system-history", "required", "h".repeat(1_750)),                    // ~500
    ];
  }
  const tokensOf = (items: readonly RenderedPromptSection[]) =>
    items.reduce((sum, item) => sum + item.measurement.estimatedTokens, 0);

  it("degrades a 65k medium model whose prompt exceeds its window share, preserving required order", () => {
    const sections = wideFixture();
    const budget = Math.floor(65_536 * 0.35);
    expect(tokensOf(sections)).toBeGreaterThan(budget);

    const result = applyCapabilityAwarePromptDegradation(sections, profile(65_536, "medium"));

    expect(result.telemetry).toMatchObject({
      mode: "constrained-local",
      reason: "measured-context-budget",
      contextEvidence: "measured",
      promptBudgetTokens: budget,
    });
    expect(tokensOf(result.sections)).toBeLessThanOrEqual(budget);
    expect(result.telemetry.degradedSections.length).toBeGreaterThan(0);
    const expectedOrder = sections
      .filter((item) => !result.telemetry.degradedSections.some(({ id }) => id === item.id))
      .map((item) => item.id);
    expect(result.sections.map((item) => item.id)).toEqual(expectedOrder);
    for (const required of sections.filter((item) => item.policy === "required")) {
      expect(result.sections).toContain(required);
    }
    expect(result.prompt).toBe(result.sections.map((item) => item.text).join(""));
  });

  it("keeps the same 37k prompt whole on a 131k window because it fits the share", () => {
    const sections = wideFixture();
    const result = applyCapabilityAwarePromptDegradation(sections, profile(131_072, "medium"));
    expect(result.telemetry).toMatchObject({
      mode: "full",
      reason: "within-prompt-budget",
      promptBudgetTokens: Math.floor(131_072 * 0.35),
      degradedSections: [],
    });
    expect(result.sections).toEqual(sections);
  });

  it("budgets a 32k weak model exactly as before the gate was removed", () => {
    const sections = constrainedFixture();
    const result = applyCapabilityAwarePromptDegradation(sections, profile(32_768, "weak"));
    expect(result.telemetry).toMatchObject({
      mode: "full",
      reason: "within-prompt-budget",
      promptBudgetTokens: Math.floor(32_768 * 0.35),
    });
    const over = [...sections, section("smart-context-2", "degradable", "x".repeat(60_000))];
    const shed = applyCapabilityAwarePromptDegradation(over, profile(32_768, "weak"));
    expect(shed.telemetry.mode).toBe("constrained-local");
    expect(tokensOf(shed.sections)).toBeLessThanOrEqual(Math.floor(32_768 * 0.35));
  });

  it("reports required-sections-exceed-budget when required alone overflow a 65k share", () => {
    const sections = [
      section("core-identity", "required", "i".repeat(90_000), "static"), // ~25.7k > 22,937
      section("app-manifest", "degradable", "m".repeat(3_500), "static"),
      section("system-history", "required", "history"),
    ];
    const result = applyCapabilityAwarePromptDegradation(sections, profile(65_536, "medium"));
    expect(result.telemetry).toMatchObject({
      mode: "constrained-local",
      reason: "required-sections-exceed-budget",
      degradedSections: [{ id: "app-manifest" }],
      includedSectionIds: ["core-identity", "system-history"],
    });
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
    expect(result.telemetry.reason).toBe("unknown-context-conservative-budget");
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

  it("drops the protocol-load notice last, after every other optional section", () => {
    // Budget is 8_192 * 0.35 tokens; every degradable section here is far too
    // big to co-exist, so all of them must be shed. Order of shedding is the
    // assertion: retrieval is what survives longest.
    // The REQUIRED section alone busts the budget, so the loop cannot stop
    // early and every degradable section is shed — which is what makes the
    // shed sequence observable.
    const bulk = (tag: string) => tag.repeat(6_000);
    const sections = [
      section("core-identity", "required", "i".repeat(40_000), "static"),
      section("app-manifest", "degradable", bulk("m"), "static"),
      section("smart-context", "degradable", bulk("s")),
      section("memory-orchestrator", "degradable", bulk("o")),
      section("memory-curate", "degradable", bulk("c")),
      section("learned-protocol", "degradable", "\n\n[HARNESS NOTE: LEARNED WORKFLOW]\nload it\n[END HARNESS NOTE]\n"),
    ];
    const shedOrder = applyCapabilityAwarePromptDegradation(sections, profile(8_192))
      .telemetry.degradedSections.map((item) => item.id);

    expect(shedOrder.indexOf("learned-protocol")).toBe(shedOrder.length - 1);
    for (const earlier of ["app-manifest", "smart-context", "memory-orchestrator", "memory-curate"]) {
      expect(shedOrder.indexOf(earlier), earlier).toBeLessThan(shedOrder.indexOf("learned-protocol"));
    }
  });

  it("keeps the protocol-load notice while any other optional section is still affordable", () => {
    const sections = [
      section("core-identity", "required", "identity", "static"),
      section("smart-context", "degradable", "s".repeat(40_000)),
      section("memory-curate", "degradable", "curate hint"),
      section("learned-protocol", "degradable", "load the protocol"),
    ];
    const result = applyCapabilityAwarePromptDegradation(sections, profile(8_192));
    expect(result.telemetry.degradedSections.map((item) => item.id)).toEqual(["smart-context"]);
    expect(result.prompt).toContain("load the protocol");
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

// The priority-class allocator against the REAL config/system-prompt.md. The
// 2026-09-08 log line this fixes: `mode=constrained-local
// reason=required-sections-exceed-budget window=65536 budget=22937 full=36151
// top=core-identity:21824,context-block:4184,tool-guidance:2544` — the user's
// facts and the workspace map were shed first and ~22k tokens of behaviour
// rules stayed. Sizes below mirror that line; app-manifest and agents-md are
// whatever this checkout renders (both count as real sizes, both non-tuning).
describe("priority-class allocation over the real base prompt", () => {
  const tokensOf = (items: readonly RenderedPromptSection[]) =>
    items.reduce((sum, item) => sum + item.measurement.estimatedTokens, 0);
  const ofClass = (items: readonly RenderedPromptSection[], cls: PromptPriority) =>
    items.filter((item) => promptPriorityOf(item) === cls);

  async function realSections(opts: { toolChars: number; contextChars: number; memoryChars: number }) {
    const basePrompt = loadSystemPrompt();
    expect(basePrompt.length).toBeGreaterThan(10_000);
    const built = await createSystemPromptBuilder({
      basePrompt,
      providerHint: "\n\n[System: powered by Ollama]",
      toolPromptSection: "\n\n## Tool Guidance\n" + "t".repeat(opts.toolChars),
      contextBlock: "c".repeat(opts.contextChars),
      relevantMemories: "v".repeat(opts.memoryChars),
      smartContext: "s".repeat(Math.floor(opts.memoryChars / 2)),
    }).buildWithTelemetry();
    const sections = built.renderedSections;
    expect(sections.filter((s) => s.id.startsWith("core-identity/")).length).toBeGreaterThanOrEqual(10);
    return sections;
  }

  /** Largest-first shed within tuning, until the rest fits: the ids the allocator must drop. */
  function expectedTuningShed(sections: readonly RenderedPromptSection[], budget: number): string[] {
    let remaining = tokensOf(sections);
    const dropped: string[] = [];
    for (const part of [...ofClass(sections, "tuning")]
      .sort((l, r) => r.measurement.estimatedTokens - l.measurement.estimatedTokens)) {
      if (remaining <= budget) break;
      dropped.push(part.id);
      remaining -= part.measurement.estimatedTokens;
    }
    return dropped;
  }

  it("65k medium: keeps every safety, identity, navigation and facts section and sheds only as much tuning as must go", async () => {
    const sections = await realSections({ toolChars: 8_900, contextChars: 14_600, memoryChars: 3_000 });
    const budget = Math.floor(65_536 * 0.35);
    expect(tokensOf(sections)).toBeGreaterThan(budget);
    const nonTuning = sections.filter((s) => promptPriorityOf(s) !== "tuning");
    expect(tokensOf(nonTuning), "precondition: everything but tuning fits the 65k share").toBeLessThanOrEqual(budget);

    const result = applyCapabilityAwarePromptDegradation(sections, profile(65_536, "medium"));

    expect(result.telemetry).toMatchObject({ mode: "constrained-local", reason: "measured-context-budget", promptBudgetTokens: budget });
    expect(tokensOf(result.sections)).toBeLessThanOrEqual(budget);
    for (const section of nonTuning) expect(result.sections, section.id).toContain(section);
    const shed = result.telemetry.degradedSections.map((item) => item.id);
    expect(shed).toEqual(expectedTuningShed(sections, budget));
    // The one 12k-token part is what goes; the small tuning parts survive.
    expect(shed).toContain("core-identity/how-to-work");
    expect(ofClass(result.sections, "tuning").length).toBeGreaterThan(0);
    // Facts are IN — that is the whole campaign.
    expect(result.telemetry.includedSectionIds).toEqual(expect.arrayContaining(["context-block", "relevant-memories", "smart-context"]));
    // Order is file order, byte-for-byte.
    expect(result.prompt).toBe(sections.filter((s) => !shed.includes(s.id)).map((s) => s.text).join(""));
  });

  it("32k weak: sheds tuning largest-first down to what fits while safety, identity, navigation and facts stay whole", async () => {
    // app-manifest is excluded here: with this checkout's ~2.5k-token manifest
    // plus the ~4.1k tokens of navigation prose in the base file, navigation +
    // safety + identity alone leave no room for facts in an 11,468-token share.
    // That is a real finding about the 32k tier, not something to hide with a
    // smaller fixture — but this test pins the class ORDER, so it holds the
    // non-tuning total under the share deliberately.
    const sections = (await realSections({ toolChars: 3_500, contextChars: 4_000, memoryChars: 1_200 }))
      .filter((s) => s.id !== "app-manifest");
    const budget = Math.floor(32_768 * 0.35);
    const nonTuning = sections.filter((s) => promptPriorityOf(s) !== "tuning");
    expect(tokensOf(nonTuning), "precondition: everything but tuning fits the 32k share").toBeLessThanOrEqual(budget);
    expect(tokensOf(sections)).toBeGreaterThan(budget);

    const result = applyCapabilityAwarePromptDegradation(sections, profile(32_768, "weak"));

    expect(result.telemetry.mode).toBe("constrained-local");
    expect(tokensOf(result.sections)).toBeLessThanOrEqual(budget);
    expect(result.sections.filter((s) => promptPriorityOf(s) !== "tuning")).toEqual(nonTuning);
    const shed = result.telemetry.degradedSections.map((item) => item.id);
    expect(shed).toEqual(expectedTuningShed(sections, budget));
    expect(shed).toContain("core-identity/how-to-work");
    // Largest-first: no kept tuning part is bigger than any shed one, and a
    // kept part is kept only because it fits — the smallest shed part would not.
    const kept = ofClass(result.sections, "tuning");
    const shedSizes = shed.map((id) => sections.find((s) => s.id === id)!.measurement.estimatedTokens);
    for (const part of kept) expect(part.measurement.estimatedTokens).toBeLessThanOrEqual(Math.min(...shedSizes));
    expect(tokensOf(result.sections) + Math.min(...shedSizes)).toBeGreaterThan(budget);
  });

  it("8k: required-sections-exceed-budget still fires when safety + identity alone overflow, after everything sheddable is gone", async () => {
    const sections = await realSections({ toolChars: 8_900, contextChars: 14_600, memoryChars: 3_000 });
    const budget = Math.floor(8_192 * 0.35);
    const floor = sections.filter((s) => ["safety", "identity"].includes(promptPriorityOf(s)));
    expect(tokensOf(floor)).toBeGreaterThan(budget);

    const result = applyCapabilityAwarePromptDegradation(sections, profile(8_192, "weak"));

    expect(result.telemetry.reason).toBe("required-sections-exceed-budget");
    expect(result.sections).toEqual(floor);
    // Shed order across classes: every tuning part before any navigation part,
    // every navigation part before any facts part.
    const shed = result.telemetry.degradedSections.map((item) => promptPriorityOf(sections.find((s) => s.id === item.id)!));
    const lastIndex = (cls: PromptPriority) => shed.lastIndexOf(cls);
    const firstIndex = (cls: PromptPriority) => shed.indexOf(cls);
    expect(lastIndex("tuning")).toBeLessThan(firstIndex("navigation"));
    expect(lastIndex("navigation")).toBeLessThan(firstIndex("facts"));
  });

  it("an unknown base-prompt heading classifies as tuning and is shed before navigation and facts", async () => {
    const built = await createSystemPromptBuilder({
      basePrompt: "You are X.\n## Core rules\nnever\n## Some Heading Nobody Classified\n" + "x".repeat(20_000) + "\n## Apps & Pages\nnav",
      providerHint: "",
      contextBlock: "a fact",
    }).buildWithTelemetry();
    const unknown = built.renderedSections.find((s) => s.id === "core-identity/some-heading-nobody-classified")!;
    expect(promptPriorityOf(unknown)).toBe("tuning");
    // Without this checkout's real (~2.5k-token) app-manifest, so the unknown
    // part is the only thing that has to go on an 8k window.
    const sections = built.renderedSections.filter((s) => s.id !== "app-manifest");
    const result = applyCapabilityAwarePromptDegradation(sections, profile(8_192));
    expect(result.telemetry.degradedSections.map((item) => item.id)).toEqual([unknown.id]);
    expect(result.telemetry.includedSectionIds).toEqual(expect.arrayContaining(["core-identity/apps-pages", "context-block"]));
  });

  it("a section with no class falls back to its policy: required ⇒ safety, degradable ⇒ facts", () => {
    expect(promptPriorityOf(section("x", "required", "t"))).toBe("safety");
    expect(promptPriorityOf(section("y", "degradable", "t"))).toBe("facts");
    expect(promptPriorityOf({ policy: "required", priority: "tuning" })).toBe("tuning");
  });
});
