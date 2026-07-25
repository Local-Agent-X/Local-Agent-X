/**
 * Tool descriptions must not steer at a model-locked path.
 *
 * LAX is a model-flexible OS: the same tool schema is handed to Grok, Ollama,
 * GPT and Claude. A description that says "use the Gmail MCP tool instead" is
 * dead advice on every non-Anthropic model — that connector does not exist
 * there — and it actively suppresses the portable tool the user configured, in
 * favour of nothing.
 *
 * This is the RUNTIME mirror of CHECK 1 in
 * scripts/check-integration-conformance.mjs. The gate parses source text; this
 * reads the descriptions the model is actually shipped, after applyPrompts()
 * has composed them — so a steer appended at registration time (a toolPrompts
 * entry, a decorator) fails here even though the source scan cannot see it.
 * Keep the two STEERS lists identical.
 *
 * The patterns match ROUTING, not vendor names. Naming a vendor is legitimate
 * (memory_ingest lists ChatGPT and Claude.ai as supported import formats);
 * sending the model somewhere else is not.
 */

import { describe, it, expect } from "vitest";
import { allTools } from "../src/tools.js";

// Verbatim from scripts/check-integration-conformance.mjs (STEERS), plus a
// label so a failure names the shape, not just the offending tool.
const STEERS: Array<{ label: string; re: RegExp }> = [
  { label: "names a vendor MCP connector", re: /\b(gmail|google calendar|google drive)\s+mcp\b/i },
  { label: "routes to an MCP tool/server/connector", re: /\bmcp (tool|server|connector)\b[^.]{0,40}\b(instead|when connected|if connected)\b/i },
  { label: "'use the … MCP … instead' routing", re: /\buse the\b[^.]{0,40}\bmcp\b[^.]{0,30}\b(instead|when connected)\b/i },
  { label: "routes to a vendor connector/integration", re: /\b(use|prefer|switch to|route to)\b[^.]{0,60}\b(claude\.ai|chatgpt|copilot)\b[^.]{0,60}\b(connector|integration|tool)\b/i },
  { label: "branches on which model is driving", re: /\bwhen (you are|you're|using) (claude|chatgpt|gpt|gemini|grok)\b/i },
  { label: "branches on which model is driving", re: /\bif (you are|you're) (claude|chatgpt|gpt|gemini|grok)\b/i },
];

/** All steers found in one description, as human-readable reasons. */
function steersIn(description: string): string[] {
  return STEERS.filter((s) => s.re.test(description)).map((s) => s.label);
}

describe("tool descriptions are model-portable", () => {
  it("the registry is actually populated (guards against a vacuous sweep)", () => {
    const names = allTools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(50);
    // The five tools this rule was written for must be in the swept set, or
    // the sweep below would pass by simply not covering them.
    for (const name of ["email_read", "email_search", "email_send", "calendar_list_events", "calendar_create_event"]) {
      expect(names, `${name} is not in allTools — the sweep no longer covers it`).toContain(name);
    }
  });

  it("no tool description routes the model to a vendor-locked path", () => {
    const offenders = allTools
      .map((t) => ({ name: t.name, reasons: steersIn(t.description) }))
      .filter((o) => o.reasons.length > 0)
      .map((o) => `${o.name}: ${o.reasons.join("; ")}`);

    expect(
      offenders,
      `Model-locked steer in tool description(s):\n  ${offenders.join("\n  ")}\n` +
        "A tool description must work no matter which model is driving. State what the tool does; " +
        "do not send the model to another vendor's connector.",
    ).toEqual([]);
  });
});

describe("the steer matcher itself", () => {
  // Non-vacuity: these are the exact strings that shipped in the five
  // descriptions before this rule landed. If the matcher is ever weakened,
  // these go green-by-accident and the sweep above stops protecting anything.
  it.each([
    "Read emails from the user's configured IMAP mailbox (email_setup). For a Gmail account connected via the claude.ai Google integration, use the Gmail MCP tool instead.",
    "List events from LAX's local calendar (calendar.json). For their real Google account, use the Google Calendar MCP tool when connected.",
    "If the user means their real Google account, use the Google Calendar MCP tool instead when it is connected.",
    "When you are Claude, prefer the built-in connector for this.",
  ])("flags the historical steer %#", (desc) => {
    expect(steersIn(desc).length).toBeGreaterThan(0);
  });

  // The rule is about routing, not about vendor names. These must stay legal
  // or the gate would force tools to lie about what they interoperate with.
  it.each([
    "Ingest conversation history from exported chat files into long-term memory. " +
      "Supports ChatGPT, Claude.ai, Claude Code, OpenAI Codex CLI, Slack, and generic JSON. " +
      "Auto-detects format. Incremental — skips already-ingested conversations.",
    "Add an MCP server to the user's configuration by name and command.",
    "List events from LAX's local calendar (calendar.json) — NOT the user's Google Calendar or any other external calendar account.",
  ])("allows a description that merely names a vendor %#", (desc) => {
    expect(steersIn(desc)).toEqual([]);
  });
});
