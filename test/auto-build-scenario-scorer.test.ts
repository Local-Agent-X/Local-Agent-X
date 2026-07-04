/**
 * Scenario-scorer tests — parser + judge response parsing + step-planner
 * response parsing + launch-spec reader. Browser-driven tests are out of
 * scope (Playwright requires a running app); covered by integration
 * testing on a real build.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenarioText } from "../src/auto-build/scenario-scorer/parser.js";
import { readLaunchSpec, LAUNCH_SPEC_FILENAME } from "../src/auto-build/scenario-scorer/launch-spec.js";
import { allocatePort, DEFAULT_BASE_PORT } from "../src/auto-build/scenario-scorer/port-alloc.js";
import {
  parseStepPlannerResponse,
  buildStepPlannerPrompt,
} from "../src/auto-build/scenario-scorer/step-planner.js";
import {
  parseJudgeResponse,
  buildJudgePrompt,
} from "../src/auto-build/scenario-scorer/judge.js";

describe("parseScenarioText", () => {
  const sample = `# Scenario 01 — Solo groomer's first day

**Persona:** Jamie, mobile groomer in Austin.

**Steps:**
1. Lands on petbook.com, clicks Start Free Trial.
2. Signs up with email + password.
3. Onboarding wizard, enters business name.
4. Adds first client.

**Pass criteria:** Every step completes. Account persists across logout.
`;

  it("extracts title, persona, steps, pass criteria", () => {
    const s = parseScenarioText(sample, "/tmp/test.md");
    expect(s.title).toContain("Solo groomer");
    expect(s.persona).toContain("Jamie");
    expect(s.steps).toHaveLength(4);
    expect(s.steps[0]).toContain("Start Free Trial");
    expect(s.passCriteria).toContain("logout");
  });

  it("throws on a scenario with no Steps: block", () => {
    expect(() => parseScenarioText("# No steps\n\n**Persona:** X", "/tmp/x.md")).toThrow(/no Steps/);
  });

  it("tolerates bullet-style steps (no numbers)", () => {
    const bulleted = `# Scenario X

**Steps:**
- First action
- Second action
- Third action
`;
    const s = parseScenarioText(bulleted, "/tmp/b.md");
    expect(s.steps).toHaveLength(3);
    expect(s.steps[1]).toBe("Second action");
  });

  it("appends continuation lines to the previous step", () => {
    const multi = `# Scenario X

**Steps:**
1. First action that
   wraps to the next line.
2. Second action.
`;
    const s = parseScenarioText(multi, "/tmp/m.md");
    expect(s.steps).toHaveLength(2);
    expect(s.steps[0]).toContain("wraps to the next line");
  });
});

describe("readLaunchSpec", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "auto-build-launch-")); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("returns null when the file is missing", () => {
    expect(readLaunchSpec(dir)).toBeNull();
  });

  it("returns null on malformed json", () => {
    writeFileSync(join(dir, LAUNCH_SPEC_FILENAME), "{not valid");
    expect(readLaunchSpec(dir)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    writeFileSync(join(dir, LAUNCH_SPEC_FILENAME), JSON.stringify({ start: "pnpm dev" })); // no ready_url
    expect(readLaunchSpec(dir)).toBeNull();
  });

  it("parses a complete spec", () => {
    writeFileSync(join(dir, LAUNCH_SPEC_FILENAME), JSON.stringify({
      start: "pnpm dev",
      ready_url: "http://localhost:5173",
      ready_timeout_ms: 90000,
      test_credentials_env: "MGT_TEST_CREDS",
    }));
    const spec = readLaunchSpec(dir);
    expect(spec).not.toBeNull();
    expect(spec!.start).toBe("pnpm dev");
    expect(spec!.readyUrl).toBe("http://localhost:5173");
    expect(spec!.readyTimeoutMs).toBe(90000);
    expect(spec!.testCredentialsEnv).toBe("MGT_TEST_CREDS");
  });

  it("defaults ready_timeout_ms when absent", () => {
    writeFileSync(join(dir, LAUNCH_SPEC_FILENAME), JSON.stringify({
      start: "pnpm dev", ready_url: "http://localhost:5173",
    }));
    const spec = readLaunchSpec(dir);
    expect(spec!.readyTimeoutMs).toBe(60000);
  });
});

describe("allocatePort", () => {
  it("worker 0 returns the base port and the original url VERBATIM (back-compat)", () => {
    const base = "http://localhost:5173";
    const a = allocatePort(base, 0);
    expect(a.port).toBe(5173);
    // Byte-identical string — same reference-equal value, no re-serialization
    // (no added trailing slash), so the serial path can't observe a change.
    expect(a.url).toBe(base);
  });

  it("undefined worker index behaves as worker 0", () => {
    const base = "http://localhost:5173/app";
    const a = allocatePort(base);
    expect(a.port).toBe(5173);
    expect(a.url).toBe(base);
  });

  it("negative worker index is treated as the serial path", () => {
    const base = "http://localhost:5173";
    expect(allocatePort(base, -1)).toEqual({ port: 5173, url: base });
  });

  it("worker N>0 gets a distinct port (base + N)", () => {
    expect(allocatePort("http://localhost:5173", 1).port).toBe(5174);
    expect(allocatePort("http://localhost:5173", 2).port).toBe(5175);
    expect(allocatePort("http://localhost:3000", 7).port).toBe(3007);
  });

  it("url rewrite preserves host + path, changes only the port", () => {
    expect(allocatePort("http://localhost:5173", 1).url).toBe("http://localhost:5173".replace("5173", "5174"));
    expect(allocatePort("http://127.0.0.1:5173/app?x=1", 2).url).toBe("http://127.0.0.1:5175/app?x=1");
    expect(allocatePort("https://localhost:4000/dashboard#top", 3).url).toBe("https://localhost:4003/dashboard#top");
  });

  it("distinct workers never collide on a port", () => {
    const ports = [0, 1, 2, 3].map(i => allocatePort("http://localhost:5173", i).port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("missing base port defaults to 3000", () => {
    // No explicit port in the url → base defaults to DEFAULT_BASE_PORT.
    expect(allocatePort("http://localhost", 0).port).toBe(DEFAULT_BASE_PORT);
    const w1 = allocatePort("http://localhost", 1);
    expect(w1.port).toBe(DEFAULT_BASE_PORT + 1);
    expect(w1.url).toBe(`http://localhost:${DEFAULT_BASE_PORT + 1}`);
    // path preserved when no base port present
    expect(allocatePort("http://localhost/app", 1).url).toBe(`http://localhost:${DEFAULT_BASE_PORT + 1}/app`);
  });

  it("garbage base url → sane default port, url left unchanged for a worker", () => {
    expect(allocatePort("not a url", 0).port).toBe(DEFAULT_BASE_PORT);
    const w = allocatePort("not a url", 1);
    expect(w.port).toBe(DEFAULT_BASE_PORT + 1);
    expect(w.url).toBe("not a url"); // unparseable → can't safely re-point
  });

  it("is pure/deterministic — same inputs, same output", () => {
    expect(allocatePort("http://localhost:5173", 2)).toEqual(allocatePort("http://localhost:5173", 2));
  });
});

describe("parseStepPlannerResponse", () => {
  it("parses a clean click plan", () => {
    const plan = parseStepPlannerResponse(
      '{"action":"click","selector":"role=button[name=/Continue/i]","value":null,"reason":"step says click Continue","confidence":0.95}'
    );
    expect(plan).not.toBeNull();
    expect(plan!.action).toBe("click");
    expect(plan!.selector).toContain("Continue");
  });

  it("parses a fill plan with value", () => {
    const plan = parseStepPlannerResponse(
      '{"action":"fill","selector":"input[name=\\"email\\"]","value":"test@example.com","reason":"signup form"}'
    );
    expect(plan!.action).toBe("fill");
    expect(plan!.value).toBe("test@example.com");
  });

  it("parses a skip plan", () => {
    const plan = parseStepPlannerResponse(
      '{"action":"skip","selector":null,"value":null,"reason":"step describes external workflow"}'
    );
    expect(plan!.action).toBe("skip");
    expect(plan!.reason).toContain("external");
  });

  it("returns null on unknown action", () => {
    expect(parseStepPlannerResponse('{"action":"hover","selector":"a","value":null}')).toBeNull();
  });

  it("returns null on malformed json", () => {
    expect(parseStepPlannerResponse("nope")).toBeNull();
    expect(parseStepPlannerResponse('{"action":"click",')).toBeNull();
  });

  it("tolerates surrounding prose", () => {
    const plan = parseStepPlannerResponse(
      'Sure. Here:\n{"action":"navigate","selector":null,"value":"http://localhost:5173/signup","reason":"step says go to signup"}\nThat\'s it.'
    );
    expect(plan!.action).toBe("navigate");
    expect(plan!.value).toBe("http://localhost:5173/signup");
  });
});

describe("buildStepPlannerPrompt", () => {
  it("includes step text and page snapshot", () => {
    const prompt = buildStepPlannerPrompt({
      stepText: "Click the Continue button",
      snapshot: "url: /signup\ntitle: Sign up",
      scenarioContext: "Onboarding",
      stepNumber: 3,
    });
    expect(prompt).toContain("Step 3: Click the Continue button");
    expect(prompt).toContain("title: Sign up");
    expect(prompt).toContain("role=button");
  });
});

describe("parseJudgeResponse", () => {
  it("parses a clean verdict", () => {
    const r = parseJudgeResponse(JSON.stringify({
      score: 8,
      met_criteria: ["signup works", "session persists"],
      failed_criteria: [],
      reasoning: "All steps clean with one minor warning.",
    }));
    expect(r).not.toBeNull();
    expect(r!.score).toBe(8);
    expect(r!.metCriteria).toContain("signup works");
    expect(r!.failedCriteria).toEqual([]);
  });

  it("rounds non-integer scores", () => {
    const r = parseJudgeResponse('{"score": 7.4, "met_criteria": [], "failed_criteria": [], "reasoning": "x"}');
    expect(r!.score).toBe(7);
  });

  it("rejects out-of-range scores", () => {
    expect(parseJudgeResponse('{"score": 11, "met_criteria": [], "failed_criteria": [], "reasoning": "x"}')).toBeNull();
    expect(parseJudgeResponse('{"score": -1, "met_criteria": [], "failed_criteria": [], "reasoning": "x"}')).toBeNull();
  });

  it("accepts camelCase aliases too", () => {
    const r = parseJudgeResponse('{"score": 7, "metCriteria": ["x"], "failedCriteria": ["y"], "reasoning": "z"}');
    expect(r!.metCriteria).toContain("x");
    expect(r!.failedCriteria).toContain("y");
  });
});

describe("buildJudgePrompt", () => {
  it("includes scenario + step trace + rubric", () => {
    const prompt = buildJudgePrompt({
      scenario: {
        path: "/tmp/s.md", title: "Test", persona: "Tester",
        steps: ["Click button"], passCriteria: "Button works",
        raw: "",
      },
      steps: [
        {
          index: 1, text: "Click button", action: "click button",
          outcome: "clicked", consoleErrors: [], networkFailures: [], status: "ok",
        },
      ],
      finalUrl: "http://localhost:5173/dashboard",
    });
    expect(prompt).toContain("Title: Test");
    expect(prompt).toContain("Click button");
    expect(prompt).toContain("Final URL: http://localhost:5173/dashboard");
    expect(prompt).toContain("rubric");
  });
});
