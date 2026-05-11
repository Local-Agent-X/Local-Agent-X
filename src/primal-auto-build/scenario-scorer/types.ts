/**
 * Scenario-scorer types — shared shapes for the Playwright-driven
 * scoring path that runs at phase-gate halts.
 */

export interface ParsedScenario {
  /** Absolute path to the scenario .md file. */
  path: string;
  /** Display name pulled from the H1 heading. */
  title: string;
  /** Free-form persona description. */
  persona: string;
  /** Ordered step list. Each step is the raw markdown bullet text. */
  steps: string[];
  /** The Pass criteria block — used by the judge as the rubric. */
  passCriteria: string;
  /** Raw markdown for fallback display. */
  raw: string;
}

export interface ProjectLaunchSpec {
  /** Command to run inside project_dir to start the app. e.g. "pnpm dev". */
  start: string;
  /** URL the driver polls to know the app is ready. */
  readyUrl: string;
  /** Max wall-clock ms to wait for readiness. */
  readyTimeoutMs: number;
  /** Optional secret name where test credentials live. Driver reads it. */
  testCredentialsEnv?: string;
}

export type ScoreStepStatus = "ok" | "warn" | "fail" | "skipped";

export interface ScoreStep {
  /** 1-indexed step number from the scenario. */
  index: number;
  /** Verbatim text of the scenario step. */
  text: string;
  /** What the driver actually did this step. */
  action: string;
  /** Outcome — what the page looked like after. */
  outcome: string;
  /** Console errors observed during this step. */
  consoleErrors: string[];
  /** Network failures (4xx/5xx, aborted, refused). */
  networkFailures: string[];
  /** Status. */
  status: ScoreStepStatus;
}

export interface ScoreReport {
  /** Scenario file the report is for. */
  scenarioPath: string;
  /** Scenario title for display. */
  scenarioTitle: string;
  /** Overall 0-10 satisfaction score. */
  score: number;
  /** Pass = score >= threshold. Threshold supplied by caller. */
  passed: boolean;
  /** Per-step trace. */
  steps: ScoreStep[];
  /** Criteria the judge said were met. */
  metCriteria: string[];
  /** Criteria the judge said failed. */
  failedCriteria: string[];
  /** One-paragraph judge reasoning. */
  reasoning: string;
  /** Wall-clock duration of the score run. */
  durationMs: number;
  /** Set when the run aborted before scoring (e.g. dev server never came up). */
  abortReason?: string;
}

export interface ScoreOptions {
  scenario: ParsedScenario;
  projectDir: string;
  launch: ProjectLaunchSpec;
  /** 0-10 threshold for pass. Default 7 (per Alex's spec). */
  threshold?: number;
  /** Wall-clock cap for the whole score run. Default 5 min. */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
}
