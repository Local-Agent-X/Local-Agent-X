/**
 * A new `browser` action is registered at NINE sites. Missing one is not a
 * cosmetic gap — it is an action that skips a policy gate, is mis-declared as
 * read-only, or is invisible to the model. This pins every site for `emulate`
 * and `layout_report`, INCLUDING the tables they must deliberately stay OUT of.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({ getRuntimeConfig: () => ({ browserSecrecy: "ask" }) }));

import { BROWSER_TOOL_DESCRIPTION, BROWSER_TOOL_PARAMETERS } from "./description.js";
import { RESET_ACTIONS, TRACKED_ACTIONS, READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS } from "./action-tables.js";
import { sensitivePageActionDecision } from "../../browser/sensitive-pages.js";
import { deriveAriAction } from "../../tool-execution/ari-action-map.js";
import { buildApprovalContext } from "../../tool-execution/approval-context.js";
import { TOOL_POLICIES_NETWORK } from "../../tool-policy/tool-policies.network.js";

const NEW_ACTIONS = ["emulate", "layout_report"] as const;
const VAULT = "https://vault.bitwarden.com/passwords";
const BANK = "https://chase.com/account";

const actionEnum = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: string[] }).enum;

describe("browser action registration: emulate + layout_report", () => {
  it("1. is dispatchable — the action enum offers both", () => {
    for (const action of NEW_ACTIONS) expect(actionEnum).toContain(action);
  });

  it("2. is described to the model, with its parameters declared", () => {
    for (const action of NEW_ACTIONS) expect(BROWSER_TOOL_DESCRIPTION).toContain(`- ${action}:`);
    for (const param of ["device", "viewport_width", "viewport_height", "user_agent", "is_mobile", "has_touch", "device_scale_factor"]) {
      expect(BROWSER_TOOL_PARAMETERS.properties).toHaveProperty(param);
    }
  });

  it("3. classifies emulate as a context reset and layout_report as neither reset nor tracked", () => {
    expect(RESET_ACTIONS.has("emulate")).toBe(true);
    expect(RESET_ACTIONS.has("layout_report")).toBe(false);
    for (const action of NEW_ACTIONS) expect(TRACKED_ACTIONS.has(action)).toBe(false);
  });

  it("4. declares layout_report read-only (its effect class) and emulate not", () => {
    expect(READ_ONLY_ACTIONS.has("layout_report")).toBe(true);
    expect(READ_ONLY_ACTIONS.has("emulate")).toBe(false);
  });

  it("5. blocks both while a human-verification challenge is on screen", () => {
    for (const action of NEW_ACTIONS) expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has(action)).toBe(true);
  });

  it("6. treats layout_report as a secret READ on a secret-bearing page", () => {
    const decision = sensitivePageActionDecision(VAULT, "layout_report");
    expect(decision.disposition).toBe("approval-required");
    expect(decision.unlocksRead).toBe(true);
  });

  it("7. treats emulate as a high-risk MUTATION on a sensitive page (it re-navigates in a fresh identity)", () => {
    const decision = sensitivePageActionDecision(BANK, "emulate");
    expect(decision.disposition).toBe("approval-required");
    expect(decision.unlocksRead).not.toBe(true);
    // ...and it is not silently treated as a read.
    expect(sensitivePageActionDecision("https://example.com/", "emulate").disposition).toBe("allow");
  });

  it("8. maps both to the kernel's read verb — neither is an http write", () => {
    for (const action of NEW_ACTIONS) expect(deriveAriAction("browser", { action })).toBe("get");
    // Guard the contrast: the real write actions still map to a write.
    expect(deriveAriAction("browser", { action: "fill" })).toBe("post");
  });

  it("9. renders a truthful approval label for emulate", () => {
    const label = buildApprovalContext("browser", { action: "emulate", device: "iphone" });
    expect(label).toMatch(/emulated/i);
    expect(label).toMatch(/iphone/);
    expect(label).toMatch(/login is dropped/i);
    // layout_report has no bespoke label and falls back to the generic one.
    expect(buildApprovalContext("browser", { action: "layout_report" })).toBe("Browser: layout_report");
  });

  it("10. is covered by the browser tool policy's catch-all allow, with no per-action override", () => {
    const rules = TOOL_POLICIES_NETWORK.browser.rules ?? [];
    const catchAll = rules.find((r) => r.id === "allow-browser");
    expect(catchAll?.decision).toBe("allow");
    expect(catchAll).not.toHaveProperty("action");
    for (const action of NEW_ACTIONS) {
      expect(rules.some((r) => (r as { action?: string }).action === action)).toBe(false);
    }
  });
});
