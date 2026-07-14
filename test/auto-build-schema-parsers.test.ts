/**
 * S6 — schema-validated auto-build parsers. Exercises the zod schemas that
 * replaced the hand-rolled JSON.parse shape checks in:
 *   - scenario-scorer/judge.ts        (ONE-SHOT: first invalid reply THROWS —
 *                                      no self-correction retry; a retried
 *                                      "clamp to 0-10" reply could pass a
 *                                      scenario the legacy parser always
 *                                      failed, softening the eval gate)
 *   - scenario-scorer/step-planner.ts (throw on unparseable, like before)
 *   - chunk-review/judgment-hook.ts   (fail-open null; violation:false is a
 *                                      VALID reply, must not burn the retry)
 *   - advisor/index.ts                (null → deterministic fallback)
 *
 * The production transports are exercised with classifyWithLLM mocked: the
 * judge's one-shot local validation runs its zod-backed `parse` directly;
 * the other three run the real classifySchema retry/validation logic
 * against each site's schema.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/classifiers/classify-with-llm.js", () => ({
  classifyWithLLM: vi.fn(),
}));

import { classifyWithLLM } from "../src/classifiers/classify-with-llm.js";
import { judgeScenario, parseJudgeResponse, type JudgeInput } from "../src/auto-build/scenario-scorer/judge.js";
import { chooseStepAction, parseStepPlannerResponse } from "../src/auto-build/scenario-scorer/step-planner.js";
import { defaultJudgmentHook, parseJudgmentResponse } from "../src/auto-build/chunk-review/judgment-hook.js";
import { consultAdvisor, parseAdvisorResponse, type SystemicHaltPatternSituation } from "../src/auto-build/advisor/index.js";
import { parseChunkReport } from "../src/auto-build/chunk-review/report-parser.js";
import type { ParsedChunk } from "../src/auto-build/plan-parser.js";

const mockLlm = vi.mocked(classifyWithLLM);

beforeEach(() => {
  mockLlm.mockReset();
});

// ── judge ──────────────────────────────────────────────────────────────────

const judgeInput: JudgeInput = {
  scenario: {
    path: "/tmp/s.md", title: "Signup", persona: "New user",
    steps: ["Click sign up"], passCriteria: "Account created", raw: "",
  },
  steps: [{
    index: 1, text: "Click sign up", action: "click",
    outcome: "clicked", consoleErrors: [], networkFailures: [], status: "ok",
  }],
  finalUrl: "http://localhost:5173/welcome",
};

/**
 * The judge calls classifyWithLLM with its zod-backed parse. The mock
 * mirrors the real transport's contract: run the site's `parse` over the
 * canned raw reply, yield null when parse rejects (or when raw is null =
 * provider unavailable). One mock call = one LLM shot.
 */
function primeJudgeReply(raw: string | null): void {
  mockLlm.mockImplementation(async (opts) => (raw === null ? null : opts.parse(raw)));
}

describe("judge — one-shot schema validation", () => {
  it("valid snake_case reply parses through the production path", async () => {
    primeJudgeReply(JSON.stringify({
      score: 8, met_criteria: ["Account created"], failed_criteria: [], reasoning: "Clean run.",
    }));
    const r = await judgeScenario(judgeInput);
    expect(r.score).toBe(8);
    expect(r.metCriteria).toEqual(["Account created"]);
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it("camelCase drift is accepted, camel wins over snake", () => {
    const r = parseJudgeResponse(
      '{"score": 6.6, "metCriteria": ["a"], "met_criteria": ["ignored"], "failedCriteria": ["b"], "reasoning": "z"}'
    );
    expect(r).toEqual({ score: 7, metCriteria: ["a"], failedCriteria: ["b"], reasoning: "z" });
  });

  it("string score is coerced like the legacy Number() parser", () => {
    const r = parseJudgeResponse('{"score": "7", "met_criteria": [], "failed_criteria": [], "reasoning": "x"}');
    expect(r!.score).toBe(7);
  });

  it("out-of-range score THROWS on the FIRST reply — no self-correction retry (eval-gate pin)", async () => {
    primeJudgeReply('{"score": 11, "met_criteria": [], "failed_criteria": [], "reasoning": "x"}');
    await expect(judgeScenario(judgeInput)).rejects.toThrow("judge returned unparseable response");
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it("wrong-shape / unparseable reply THROWS on the FIRST reply — one shot only", async () => {
    primeJudgeReply("not json at all");
    await expect(judgeScenario(judgeInput)).rejects.toThrow("judge returned unparseable response");
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it("provider-unavailable (null) THROWS — never a silent score", async () => {
    primeJudgeReply(null);
    await expect(judgeScenario(judgeInput)).rejects.toThrow("judge returned unparseable response");
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });
});

// ── step planner ───────────────────────────────────────────────────────────

const stepInput = {
  stepText: "Click the Continue button",
  snapshot: "url: /signup",
  scenarioContext: "Onboarding",
  stepNumber: 1,
};

describe("step planner — schema validation", () => {
  it("valid plan parses through the production path", async () => {
    mockLlm.mockResolvedValueOnce('{"action":"fill","selector":"input[name=\\"email\\"]","value":"a@b.c","reason":"form","confidence":0.9}');
    const plan = await chooseStepAction(stepInput);
    expect(plan).toEqual({ action: "fill", selector: 'input[name="email"]', value: "a@b.c", reason: "form", confidence: 0.9 });
  });

  it("drift: wrong-typed optional fields fall back to defaults, not failure", () => {
    const plan = parseStepPlannerResponse('{"action":"skip","selector":42,"value":{},"confidence":"high"}');
    expect(plan).toEqual({ action: "skip", selector: null, value: null, reason: "", confidence: undefined });
  });

  it("unknown action throws after the retry (existing failure behavior)", async () => {
    mockLlm.mockResolvedValue('{"action":"hover","selector":"a","value":null}');
    await expect(chooseStepAction(stepInput)).rejects.toThrow("step planner returned unparseable response");
    expect(mockLlm).toHaveBeenCalledTimes(2);
  });
});

// ── judgment hook ──────────────────────────────────────────────────────────

const hookChunk: ParsedChunk = {
  number: 12, title: "Public booking page UI", phase: "Phase D",
  klass: "leaf", slice: "/[host]/[type] route", dependsOn: [10],
  scenarios: "1", doneWhen: "page renders.", rawSection: "",
};

describe("judgment hook — schema validation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s6-judgment-"));
    writeFileSync(join(dir, "CONSTITUTION.md"), "No silent failures affecting the user.");
    writeFileSync(join(dir, "page.tsx"), "export const Page = () => null;");
  });

  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  function hookInput() {
    return {
      chunk: hookChunk,
      report: parseChunkReport("STATUS: done\nCHANGED: page.tsx\nNOTE: ok"),
      projectDir: dir,
    };
  }

  it("violation:true maps to a JudgmentResult", async () => {
    mockLlm.mockResolvedValueOnce('{"violation": true, "rule": "no silent failures", "pattern": "stale render", "specGap": "Show stale notice.", "reasoning": "renders degraded data"}');
    const r = await defaultJudgmentHook(hookInput());
    expect(r).not.toBeNull();
    expect(r!.specGap).toBe("Show stale notice.");
    expect(r!.reasoning).toContain("no silent failures");
  });

  it("violation:false is a VALID reply → null verdict, no self-correction retry", async () => {
    mockLlm.mockResolvedValue('{"violation": false, "rule": "", "pattern": "", "specGap": "", "reasoning": ""}');
    const r = await defaultJudgmentHook(hookInput());
    expect(r).toBeNull();
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it("garbage reply fails open to null after the retry (never blocks the build)", async () => {
    mockLlm.mockResolvedValue("not json at all");
    const r = await defaultJudgmentHook(hookInput());
    expect(r).toBeNull();
    expect(mockLlm).toHaveBeenCalledTimes(2);
  });

  it("drift: violation:true with whitespace-only specGap → null, not a retry", () => {
    expect(parseJudgmentResponse('{"violation": true, "specGap": "   ", "reasoning": "z"}')).toBeNull();
  });
});

// ── advisor ────────────────────────────────────────────────────────────────

const systemicSituation: SystemicHaltPatternSituation = {
  kind: "systemic-halt-pattern",
  gate: "phase-verify",
  recentHalts: [
    { chunk: 3, gate: "phase-verify", reason: "scenario 1 scored 4", at: "2026-07-13T00:00:00Z" },
    { chunk: 4, gate: "phase-verify", reason: "scenario 1 scored 3", at: "2026-07-13T01:00:00Z" },
    { chunk: 5, gate: "phase-verify", reason: "scenario 1 scored 4", at: "2026-07-13T02:00:00Z" },
  ],
  projectDir: "/nonexistent",
};

describe("advisor — schema validation", () => {
  it("valid halt reply parses through the production path", async () => {
    mockLlm.mockResolvedValueOnce('{"action": "halt", "reasoning": "same gate 3x", "haltReason": "Inspect scenario 1 selectors."}');
    const rec = await consultAdvisor(systemicSituation);
    expect(rec).toEqual({ action: "halt", reasoning: "same gate 3x", haltReason: "Inspect scenario 1 selectors." });
  });

  it("halt without haltReason drifts to reasoning (legacy behavior)", () => {
    const rec = parseAdvisorResponse('{"action": "halt", "reasoning": "stuck"}');
    expect(rec!.haltReason).toBe("stuck");
  });

  it("unknown action → null after the retry (caller falls back deterministically)", async () => {
    mockLlm.mockResolvedValue('{"action": "ignore", "reasoning": "x"}');
    const rec = await consultAdvisor(systemicSituation);
    expect(rec).toBeNull();
    expect(mockLlm).toHaveBeenCalledTimes(2);
  });

  it("amend-spec-additively without a specAddition is invalid", () => {
    expect(parseAdvisorResponse('{"action": "amend-spec-additively", "reasoning": "x", "specAddition": ""}')).toBeNull();
  });

  it("retry-with-hint requires a hint; try-fix-worker tolerates an empty one", () => {
    expect(parseAdvisorResponse('{"action": "retry-with-hint", "reasoning": "x"}')).toBeNull();
    const rec = parseAdvisorResponse('{"action": "try-fix-worker", "reasoning": "x"}');
    expect(rec).toEqual({ action: "try-fix-worker", reasoning: "x", fixWorkerHint: "" });
  });
});
