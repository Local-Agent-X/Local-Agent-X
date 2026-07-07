import { describe, it, expect } from "vitest";
import { loadSystemPrompt } from "./config-loader.js";
import { buildExecutionRules } from "./server/handler-events.js";

// Prompt contract — pins the supervisor-side Delegation / Background-operations
// guidance in config/system-prompt.md so future prompt edits can't silently
// regress the delegation-craft campaign (8efea831, bf027eea, e296eb375).
// Loaded via the REAL loader, not a hardcoded copy: this asserts what the
// running server actually ships as its system prompt.

const prompt = loadSystemPrompt();

/** The "## Delegation" section body, up to the next H2 heading. */
function delegationSection(): string {
  const match = prompt.match(/^## Delegation$([\s\S]*?)(?=^## )/m);
  expect(match, "system prompt must contain a '## Delegation' H2 section").toBeTruthy();
  return match![1];
}

/** The "## Background operations" section body, up to the next H2 heading. */
function backgroundOpsSection(): string {
  const match = prompt.match(/^## Background operations$([\s\S]*?)(?=^## )/m);
  expect(match, "system prompt must contain a '## Background operations' H2 section").toBeTruthy();
  return match![1];
}

describe("supervisor prompt contract — Delegation section", () => {
  it("keeps the chat responsive: heavy work goes to workers, never ground inline", () => {
    const section = delegationSection();
    expect(section).toContain("The chat must stay responsive");
    expect(section).toContain("never grind inline on heavy work");
  });

  it("requires self-contained briefs because workers cannot see the conversation", () => {
    const section = delegationSection();
    expect(section).toContain("Workers CANNOT see this conversation");
    expect(section).toContain("Every brief must be self-contained");
  });

  it("names the banned lazy brief phrases verbatim", () => {
    const section = delegationSection();
    expect(section).toContain('"Based on your findings"');
    expect(section).toContain('"fix the bug we discussed"');
    expect(section).toContain('"continue the work"');
    expect(section).toContain("guaranteed failures");
  });

  it("scopes steering (agent_message / agent_redirect) to STILL-RUNNING workers only", () => {
    const section = delegationSection();
    expect(section).toMatch(
      /`agent_message`[^\n]*`agent_redirect`[^\n]*ONLY on a worker that is STILL RUNNING/,
    );
    expect(section).toContain("messaging a completed run is a silent no-op");
  });

  it("mandates spawning FRESH after a worker reports (terminal runs never continue)", () => {
    const section = delegationSection();
    expect(section).toContain("Once a worker has reported, its run is terminal");
    expect(section).toContain("spawn a FRESH worker");
    expect(section).toContain('Never write "continue where the last worker left off"');
  });
});

describe("supervisor prompt contract — removed tools stay removed", () => {
  it("never mentions agent_pause or agent_resume", () => {
    expect(prompt).not.toMatch(/agent_pause/);
    expect(prompt).not.toMatch(/agent_resume/);
  });

  it("never mentions the removed operation_start tool", () => {
    expect(prompt).not.toMatch(/operation_start/);
  });
});

describe("supervisor prompt contract — Background operations section", () => {
  it("names the always-available op supervisor trio", () => {
    const section = backgroundOpsSection();
    expect(section).toContain("`op_status`");
    expect(section).toContain("`op_kill`");
    expect(section).toContain("`op_redirect`");
  });

  it("describes op_submit_async as loading via tool search, not eager", () => {
    const section = backgroundOpsSection();
    expect(section).toMatch(/`op_submit_async`[\s\S]*?load via tool search/);
  });
});

describe("cross-seam contract — supervisor expectations match worker rules", () => {
  it("supervisor reads BACKGROUND COMPLETIONS previews AND workers are told to lead with the outcome", () => {
    // Supervisor half: results surface as a BACKGROUND COMPLETIONS block whose
    // entries carry only short result previews.
    const results = delegationSection();
    expect(results).toContain("BACKGROUND COMPLETIONS");
    expect(results).toContain("result previews");
    expect(backgroundOpsSection()).toContain("BACKGROUND COMPLETIONS");

    // Worker half: buildExecutionRules instructs the outcome-first final
    // report in BOTH worker variants, so the preview the supervisor surfaces
    // actually contains the result.
    for (const requiresWorktree of [true, false]) {
      const rules = buildExecutionRules("Linux/macOS. bash runs /bin/bash.", 60, requiresWorktree);
      expect(rules).toContain("Final report: lead with the concrete outcome");
      expect(rules).toContain("short preview");
    }
  });
});
