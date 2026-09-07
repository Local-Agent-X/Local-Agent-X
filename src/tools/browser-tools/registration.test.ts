/**
 * A new `browser` action is registered at NINE sites. Missing one is not a
 * cosmetic gap — it is an action that skips a policy gate, is mis-declared as
 * read-only, or is invisible to the model. This pins every site for `emulate`,
 * INCLUDING the tables it must deliberately stay OUT of.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({ getRuntimeConfig: () => ({ browserSecrecy: "ask" }) }));

import { BROWSER_TOOL_DESCRIPTION, BROWSER_TOOL_PARAMETERS } from "./description.js";
import { RESET_ACTIONS, TRACKED_ACTIONS, READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS } from "./action-tables.js";
import { sensitivePageActionDecision } from "../../browser/sensitive-pages.js";
import { deriveAriAction } from "../../tool-execution/ari-action-map.js";
import { buildApprovalContext } from "../../tool-execution/approval-context.js";
import { TOOL_POLICIES_NETWORK } from "../../tool-policy/tool-policies.network.js";

const BANK = "https://chase.com/account";

const actionEnum = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: string[] }).enum;

describe("browser action registration: emulate", () => {
  it("1. is dispatchable — the action enum offers it", () => {
    expect(actionEnum).toContain("emulate");
  });

  it("2. is described to the model, with its parameters declared", () => {
    expect(BROWSER_TOOL_DESCRIPTION).toContain("- emulate:");
    for (const param of ["device", "viewport_width", "viewport_height", "user_agent", "is_mobile", "has_touch", "device_scale_factor"]) {
      expect(BROWSER_TOOL_PARAMETERS.properties).toHaveProperty(param);
    }
  });

  it("3. classifies emulate as a context reset, not a tracked (advancing) action", () => {
    expect(RESET_ACTIONS.has("emulate")).toBe(true);
    expect(TRACKED_ACTIONS.has("emulate")).toBe(false);
  });

  it("4. does not declare emulate read-only (its effect class)", () => {
    expect(READ_ONLY_ACTIONS.has("emulate")).toBe(false);
  });

  it("5. blocks emulate while a human-verification challenge is on screen", () => {
    expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has("emulate")).toBe(true);
  });

  it("6. treats emulate as a high-risk MUTATION on a sensitive page (it re-navigates in a fresh identity)", () => {
    const decision = sensitivePageActionDecision(BANK, "emulate");
    expect(decision.disposition).toBe("approval-required");
    expect(decision.unlocksRead).not.toBe(true);
    // ...and it is not silently treated as a read.
    expect(sensitivePageActionDecision("https://example.com/", "emulate").disposition).toBe("allow");
  });

  it("7. maps to the kernel's read verb — it is not an http write", () => {
    expect(deriveAriAction("browser", { action: "emulate" })).toBe("get");
    // Guard the contrast: the real write actions still map to a write.
    expect(deriveAriAction("browser", { action: "fill" })).toBe("post");
  });

  it("8. renders a truthful approval label naming the device / size and that the login drops", () => {
    const label = buildApprovalContext("browser", { action: "emulate", device: "iphone" });
    expect(label).toMatch(/emulated/i);
    expect(label).toMatch(/iphone/);
    expect(label).toMatch(/login is dropped/i);
    const sized = buildApprovalContext("browser", { action: "emulate", viewport_width: 360, viewport_height: 640 });
    expect(sized).toContain("360x640");
  });

  it("9. is covered by the browser tool policy's catch-all allow, with no per-action override", () => {
    const rules = TOOL_POLICIES_NETWORK.browser.rules ?? [];
    const catchAll = rules.find((r) => r.id === "allow-browser");
    expect(catchAll?.decision).toBe("allow");
    expect(catchAll).not.toHaveProperty("action");
    expect(rules.some((r) => (r as { action?: string }).action === "emulate")).toBe(false);
  });
});
