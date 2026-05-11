/**
 * Advisor tests — exercise the LLM-driven recovery decision layer with
 * stubbed LLM responses so tests are deterministic.
 *
 * Covers:
 *   - parseAdvisorResponse: all three actions + malformed cases
 *   - buildAdvisorPrompt: includes constitution + scenarios + situation
 *   - consultAdvisor end-to-end with an injected LlmCall
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consultAdvisor,
  parseAdvisorResponse,
  buildAdvisorPrompt,
  type PhaseGateFailureSituation,
} from "../src/primal-auto-build/advisor/index.js";
import type { ParsedChunk } from "../src/primal-auto-build/plan-parser.js";
import type { ScoreReport } from "../src/primal-auto-build/scenario-scorer/types.js";

const baseChunk: ParsedChunk = {
  number: 5,
  title: "Web app skeleton + auth UI",
  phase: "Phase A — Foundation",
  klass: "leaf",
  slice: "Vite + React + auth flow",
  dependsOn: [3, 4],
  scenarios: "1",
  doneWhen: "signup/logout loop persists state",
  rawSection: "",
};

function makeReport(title: string, score: number): ScoreReport {
  return {
    scenarioPath: `/proj/scenarios/${title}.md`,
    scenarioTitle: title,
    score,
    passed: score >= 7,
    steps: [],
    metCriteria: score >= 7 ? ["happy path"] : [],
    failedCriteria: score < 7 ? ["session persistence"] : [],
    reasoning: score < 7 ? "Logout button removes cookie but doesn't redirect to /login" : "Worked end to end",
    durationMs: 5000,
  };
}

describe("parseAdvisorResponse", () => {
  it("parses try-fix-worker recommendation", () => {
    const rec = parseAdvisorResponse(JSON.stringify({
      action: "try-fix-worker",
      reasoning: "Logout redirect is a simple bug.",
      fixWorkerHint: "After clearing the cookie, navigate to /login.",
      specAddition: "",
      haltReason: "",
    }));
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("try-fix-worker");
    expect(rec!.fixWorkerHint).toContain("/login");
  });

  it("parses amend-spec-additively with required specAddition", () => {
    const rec = parseAdvisorResponse(JSON.stringify({
      action: "amend-spec-additively",
      reasoning: "Spec doesn't pin logout redirect target.",
      specAddition: "Logout MUST redirect the user to /login (not stay on the protected route).",
      fixWorkerHint: "",
      haltReason: "",
    }));
    expect(rec!.action).toBe("amend-spec-additively");
    expect(rec!.specAddition).toContain("Logout MUST");
  });

  it("rejects amend-spec-additively without specAddition", () => {
    const rec = parseAdvisorResponse(JSON.stringify({
      action: "amend-spec-additively",
      reasoning: "spec is incomplete",
      specAddition: "",
    }));
    expect(rec).toBeNull();
  });

  it("parses halt with reason", () => {
    const rec = parseAdvisorResponse(JSON.stringify({
      action: "halt",
      reasoning: "Ambiguous spec — user must decide.",
      haltReason: "Two valid paths; pick one in chat then resume.",
    }));
    expect(rec!.action).toBe("halt");
    expect(rec!.haltReason).toContain("Two valid paths");
  });

  it("returns null on unknown action", () => {
    expect(parseAdvisorResponse('{"action":"ignore","reasoning":"x"}')).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseAdvisorResponse("plain text reply")).toBeNull();
  });

  it("returns null when reasoning is empty", () => {
    expect(parseAdvisorResponse('{"action":"try-fix-worker","reasoning":""}')).toBeNull();
  });

  it("tolerates surrounding prose", () => {
    const rec = parseAdvisorResponse(
      'I think the right move is:\n{"action":"halt","reasoning":"needs human","haltReason":"design decision required"}\nThat works.'
    );
    expect(rec!.action).toBe("halt");
  });
});

describe("buildAdvisorPrompt", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "advisor-prompt-"));
    mkdirSync(join(projectDir, "spec"));
    writeFileSync(join(projectDir, "spec", "constitution.md"), "# Constitution\n\n1. No silent failures.\n");
  });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("includes situation + scenarios + constitution + options", () => {
    const situation: PhaseGateFailureSituation = {
      kind: "phase-gate-scenario-failure",
      chunk: baseChunk,
      failedReports: [makeReport("Auth happy path", 5)],
      passedReports: [makeReport("DB isolation", 9)],
      projectDir,
      attemptNumber: 1,
    };
    const prompt = buildAdvisorPrompt(situation);
    expect(prompt).toContain("chunk 5 — Web app skeleton");
    expect(prompt).toContain("Phase A — Foundation");
    expect(prompt).toContain("Auth happy path");
    expect(prompt).toContain("DB isolation");
    expect(prompt).toContain("No silent failures");
    expect(prompt).toContain("try-fix-worker");
    expect(prompt).toContain("amend-spec-additively");
    expect(prompt).toContain("halt");
    expect(prompt).toContain("attempt 2");
  });

  it("works without a constitution file", () => {
    const noConstDir = mkdtempSync(join(tmpdir(), "advisor-no-const-"));
    try {
      const situation: PhaseGateFailureSituation = {
        kind: "phase-gate-scenario-failure",
        chunk: baseChunk,
        failedReports: [makeReport("X", 4)],
        passedReports: [],
        projectDir: noConstDir,
        attemptNumber: 1,
      };
      const prompt = buildAdvisorPrompt(situation);
      expect(prompt).toContain("(no constitution file found)");
    } finally {
      rmSync(noConstDir, { recursive: true, force: true });
    }
  });
});

describe("consultAdvisor — end to end with stub LLM", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "advisor-e2e-"));
  });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("returns the stub's recommendation when LLM call succeeds", async () => {
    const situation: PhaseGateFailureSituation = {
      kind: "phase-gate-scenario-failure",
      chunk: baseChunk,
      failedReports: [makeReport("X", 5)],
      passedReports: [],
      projectDir,
      attemptNumber: 1,
    };
    const rec = await consultAdvisor(situation, {
      llmCall: async () => JSON.stringify({
        action: "try-fix-worker",
        reasoning: "simple bug",
        fixWorkerHint: "fix the redirect",
        specAddition: "",
        haltReason: "",
      }),
    });
    expect(rec).not.toBeNull();
    expect(rec!.action).toBe("try-fix-worker");
  });

  it("returns null on LLM error (fail-open)", async () => {
    const rec = await consultAdvisor({
      kind: "phase-gate-scenario-failure",
      chunk: baseChunk, failedReports: [], passedReports: [], projectDir, attemptNumber: 1,
    }, { llmCall: async () => { throw new Error("network down"); } });
    expect(rec).toBeNull();
  });

  it("returns null on unparseable LLM response", async () => {
    const rec = await consultAdvisor({
      kind: "phase-gate-scenario-failure",
      chunk: baseChunk, failedReports: [], passedReports: [], projectDir, attemptNumber: 1,
    }, { llmCall: async () => "I'm sorry, can't help with that." });
    expect(rec).toBeNull();
  });
});
