import { describe, it, expect } from "vitest";
import { RULES, allRules, channelIsDelivered, deliveredChannels, type RuleId } from "./rule-registry.js";
import { WIRE_FORMAT_NUDGE_ID } from "../canonical-loop/turn-loop/nudges.js";
import { CHAT_RIDER_IDS } from "../routes/chat/system-prompt-augmentations.js";

describe("rule registry shape", () => {
  it("every entry's id matches its key — the key IS the id space", () => {
    for (const [key, rule] of Object.entries(RULES)) expect(rule.id).toBe(key as RuleId);
  });

  it("every rule has at least one channel and a one-line summary", () => {
    for (const rule of allRules()) {
      expect(rule.channels.length, `${rule.id} has no channel`).toBeGreaterThan(0);
      expect(rule.summary.length, `${rule.id} has no summary`).toBeGreaterThan(0);
      expect(rule.summary, `${rule.id} summary must stay one line`).not.toContain("\n");
    }
  });

  it("a rule never lists the same channel twice", () => {
    for (const rule of allRules()) {
      const keys = rule.channels.map((c) => JSON.stringify(c));
      expect(new Set(keys).size, `${rule.id} repeats a channel`).toBe(keys.length);
    }
  });

  it("nudge and rider ids come from the wiring, not from a copied string literal", () => {
    const ids = allRules().flatMap((r) => r.channels.filter((c) => c.kind === "nudge" || c.kind === "rider").map((c) => c.id));
    expect(ids).toContain(WIRE_FORMAT_NUDGE_ID);
    expect(ids).toContain(CHAT_RIDER_IDS.toolCallRequired);
  });
});

describe("channel delivery", () => {
  const included = new Set(["runtime-context", "core-identity/how-to-work"]);

  it("a prompt-part channel counts only when the part survived", () => {
    expect(channelIsDelivered({ kind: "prompt-part", part: "runtime-context" }, included)).toBe(true);
    expect(channelIsDelivered({ kind: "prompt-part", part: "core-identity/delegation" }, included)).toBe(false);
  });

  it("tool-description, error-message, nudge and rider are never shed", () => {
    const empty = new Set<string>();
    expect(channelIsDelivered({ kind: "tool-description", tool: "glob" }, empty)).toBe(true);
    expect(channelIsDelivered({ kind: "error-message", source: "x" }, empty)).toBe(true);
    expect(channelIsDelivered({ kind: "nudge", id: "n" }, empty)).toBe(true);
    expect(channelIsDelivered({ kind: "rider", id: "r" }, empty)).toBe(true);
  });

  it("deliveredChannels drops only the shed prompt parts", () => {
    const rule = RULES["long-running-process-uses-process-start"];
    expect(deliveredChannels(rule, new Set<string>()).map((c) => c.kind)).toEqual(["error-message"]);
    expect(deliveredChannels(rule, included)).toHaveLength(2);
  });
});
