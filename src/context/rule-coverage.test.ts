/**
 * Rule coverage — does every behavioural rule still REACH the model?
 *
 * Since the base prompt became priced parts (commit a52b7aa2) the allocator
 * sheds whole `## ` sections on small local windows. "How to work" is 12,236
 * tokens and is the first thing dropped, so a rule that lives only in that
 * prose is silently gone on every local model. This test builds the REAL
 * prompt (config/system-prompt.md through the loader, the real builder, the
 * real degrader) for three profiles and asserts each rule in the registry
 * still has at least one delivered channel.
 *
 * A `prompt-part` channel counts only when that part survived for the profile.
 * `tool-description`, `error-message`, `nudge` and `rider` are assembled
 * outside the prompt budget, so they always count.
 */

import { describe, it, expect } from "vitest";
import { createSystemPromptBuilder, type RenderedPromptSection } from "./system-prompt-builder.js";
import { applyCapabilityAwarePromptDegradation } from "./prompt-degradation.js";
import { allRules, deliveredChannels, includedPartIds, type RuleId } from "./rule-registry.js";
import { loadSystemPrompt } from "../config-loader.js";
import type { LocalModelCapabilityProfile } from "../local-runtimes/index.js";

function localProfile(model: string, tier: "medium" | "weak", contextWindow: number): LocalModelCapabilityProfile {
  return {
    runtimeId: "ollama",
    baseURL: "http://127.0.0.1:11434/v1",
    model,
    tier,
    maxTools: tier === "weak" ? 20 : 40,
    contextWindow,
    tools: { advertised: true, verified: true, rejectsTools: false },
  };
}

/** The three targets that matter: a cloud turn, and the two local windows we ship against. */
const PROFILES: ReadonlyArray<{ name: string; profile: LocalModelCapabilityProfile | null }> = [
  { name: "cloud (no local profile — nothing is shed)", profile: null },
  { name: "local medium, 65,536-token window", profile: localProfile("qwen3-coder:30b", "medium", 65_536) },
  { name: "local weak, 32,768-token window", profile: localProfile("gemma3:12b", "weak", 32_768) },
];

/**
 * Rules that are NOT delivered on a profile today. This is a PINNED RED FLAG,
 * not an exemption: the assertion below is an exact equality, so fixing a gap
 * (give the rule a tool-description / error-message channel, or move the prose
 * into a `safety` part) fails this test until the entry is removed, and any NEW
 * shed-only rule fails it immediately.
 *
 * Both entries are prose that exists ONLY inside `## How to work`
 * (config/system-prompt.md), class `tuning` (config-loader.ts:105) — the
 * largest part and therefore the first shed on every local window.
 */
const KNOWN_GAPS: Readonly<Record<string, readonly RuleId[]>> = {
  "cloud (no local profile — nothing is shed)": [],
  "local medium, 65,536-token window": ["terminal-work-is-never-a-handoff", "never-act-on-your-own-offer"],
  "local weak, 32,768-token window": ["terminal-work-is-never-a-handoff", "never-act-on-your-own-offer"],
};

async function realPromptSections(): Promise<RenderedPromptSection[]> {
  // The real base prompt, split at its headings by basePromptSections(), plus
  // the builder-owned sections every path gets (runtime-context, agents-md,
  // recall-reflex, app-manifest). Per-turn dynamic sections are deliberately
  // absent — no rule claims one, and they only ADD pressure, so leaving them
  // out makes this the optimistic case: what survives here is an upper bound.
  const builder = createSystemPromptBuilder({ basePrompt: loadSystemPrompt(), providerHint: "" });
  return (await builder.buildWithTelemetry()).renderedSections;
}

function includedFor(
  sections: readonly RenderedPromptSection[],
  profile: LocalModelCapabilityProfile | null,
): Set<string> {
  return includedPartIds(applyCapabilityAwarePromptDegradation(sections, profile).sections);
}

describe("behavioural rule coverage across prompt profiles", () => {
  it("the allocator really does shed on the local profiles (otherwise this test proves nothing)", async () => {
    const sections = await realPromptSections();
    const cloud = includedFor(sections, PROFILES[0].profile);
    const medium = includedFor(sections, PROFILES[1].profile);
    const weak = includedFor(sections, PROFILES[2].profile);
    expect(cloud.has("core-identity/how-to-work")).toBe(true);
    expect(medium.has("core-identity/how-to-work")).toBe(false);
    expect(weak.has("core-identity/how-to-work")).toBe(false);
    // Safety/identity parts are never candidates, so the channels rules lean on survive.
    for (const part of ["runtime-context", "agents-md", "recall-reflex", "core-identity/core-rules"]) {
      expect(weak.has(part), `${part} should never be shed`).toBe(true);
    }
  });

  for (const { name, profile } of PROFILES) {
    describe(name, () => {
      it("every rule keeps at least one delivered channel", async () => {
        const included = includedFor(await realPromptSections(), profile);
        const undelivered: RuleId[] = [];
        const table: string[] = [];
        for (const rule of allRules()) {
          const kept = deliveredChannels(rule, included);
          const shed = rule.channels.filter((c) => !kept.includes(c));
          table.push(
            `${kept.length ? "OK  " : "GONE"} ${rule.id}` +
            ` | delivered: ${kept.map(describeChannel).join(", ") || "(none)"}` +
            (shed.length ? ` | shed: ${shed.map(describeChannel).join(", ")}` : ""),
          );
          if (kept.length === 0) undelivered.push(rule.id);
        }
        // Exact equality: a fixed gap and a new gap both fail here.
        expect(undelivered, `rule delivery for ${name}:\n${table.join("\n")}\n`)
          .toEqual([...(KNOWN_GAPS[name] ?? [])]);
      });
    });
  }

  it("a rule whose only channel is a shed part is reported as undelivered", async () => {
    const included = includedFor(await realPromptSections(), PROFILES[1].profile);
    // shell-posix-not-powershell survives its prose being shed because the
    // bash tool description and shell-translate's cmdlet hint also carry it.
    const shell = deliveredChannels(
      allRules().find((r) => r.id === "shell-posix-not-powershell")!,
      included,
    );
    expect(shell.map((c) => c.kind)).toEqual(["prompt-part", "tool-description", "error-message"]);
    // The hand-off rule has no such backup and is therefore gone.
    const handoff = deliveredChannels(
      allRules().find((r) => r.id === "terminal-work-is-never-a-handoff")!,
      included,
    );
    expect(handoff).toEqual([]);
  });
});

function describeChannel(channel: { kind: string } & Record<string, unknown>): string {
  const detail = channel.part ?? channel.tool ?? channel.source ?? channel.id;
  return `${channel.kind}:${String(detail)}`;
}
