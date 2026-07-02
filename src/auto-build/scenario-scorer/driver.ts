/**
 * Playwright driver for the scenario-scorer. Drives a headless chromium
 * through the scenario's steps, collects console errors + network
 * failures + a page snapshot at each step, returns the trace.
 *
 * Step execution is LLM-light: we don't ask the LLM "what's the next
 * action" per step (too expensive, too fragile). Instead, the driver
 * uses Playwright's built-in semantic locators (role, label, text) to
 * resolve each step's intent. For each scenario step:
 *
 *   1. Snapshot the page (URL + visible text + form fields).
 *   2. Ask the LLM ONCE per step: "scenario says X; given this page, what
 *      action should I take?" → returns a {action, selector, value?}.
 *   3. Execute the action via Playwright.
 *   4. Capture errors + new state for the judge.
 *
 * The per-step LLM call is small (a few KB in/out). Average scenario
 * has ~10 steps × ~$0.003/step ≈ $0.03/scenario in Sonnet pricing.
 *
 * Browser context isolation: each scorer run gets its own context (no
 * cookies, no localStorage shared across scenarios). Headless by default.
 */

import { chromium, type Browser, type Page, type BrowserContext, type ConsoleMessage, type Request } from "playwright";
import type { ParsedScenario, ScoreStep, ScoreStepStatus } from "./types.js";
import { chooseStepAction, type StepActionPlan } from "./step-planner.js";

const STEP_TIMEOUT_MS = 30_000;

export interface DriverTrace {
  steps: ScoreStep[];
  finalUrl: string;
  finalScreenshotBase64: string;
}

export interface DriverOptions {
  scenario: ParsedScenario;
  baseUrl: string;
  signal?: AbortSignal;
}

export async function driveScenario(opts: DriverOptions): Promise<DriverTrace> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const stepResults: ScoreStep[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    const stepConsoleErrors = new Map<number, string[]>();
    const stepNetworkFailures = new Map<number, string[]>();
    let currentStepIndex = 0;

    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") {
        const arr = stepConsoleErrors.get(currentStepIndex) || [];
        arr.push(msg.text().slice(0, 200));
        stepConsoleErrors.set(currentStepIndex, arr);
      }
    });
    page.on("requestfailed", (req: Request) => {
      const arr = stepNetworkFailures.get(currentStepIndex) || [];
      arr.push(`${req.method()} ${req.url().slice(0, 120)} — ${req.failure()?.errorText}`);
      stepNetworkFailures.set(currentStepIndex, arr);
    });
    page.on("response", (res) => {
      if (res.status() >= 400) {
        const arr = stepNetworkFailures.get(currentStepIndex) || [];
        arr.push(`${res.status()} ${res.request().method()} ${res.url().slice(0, 120)}`);
        stepNetworkFailures.set(currentStepIndex, arr);
      }
    });

    await page.goto(opts.baseUrl, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });

    for (let i = 0; i < opts.scenario.steps.length; i++) {
      if (opts.signal?.aborted) break;
      currentStepIndex = i + 1;
      const stepText = opts.scenario.steps[i];

      const snapshot = await takeSnapshot(page);
      let plan: StepActionPlan;
      try {
        plan = await chooseStepAction({ stepText, snapshot, scenarioContext: opts.scenario.title, stepNumber: currentStepIndex });
      } catch (e) {
        stepResults.push({
          index: currentStepIndex, text: stepText,
          action: "(LLM step-planner failed)", outcome: (e as Error).message,
          consoleErrors: [], networkFailures: [], status: "fail",
        });
        continue;
      }

      const { outcome, status } = await executePlan(page, plan);
      stepResults.push({
        index: currentStepIndex, text: stepText,
        action: plan.action + (plan.selector ? ` → ${plan.selector}` : ""),
        outcome,
        consoleErrors: stepConsoleErrors.get(currentStepIndex) || [],
        networkFailures: stepNetworkFailures.get(currentStepIndex) || [],
        status,
      });

      if (status === "fail") break; // halt scenario on a hard failure
    }

    const finalScreenshot = await page.screenshot({ type: "png", fullPage: false }).catch(() => Buffer.alloc(0));
    return {
      steps: stepResults,
      finalUrl: page.url(),
      finalScreenshotBase64: finalScreenshot.toString("base64"),
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function takeSnapshot(page: Page): Promise<string> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const visibleText = await page.locator("body").innerText().catch(() => "");
  const formFields = await page.$$eval("input, textarea, select, button", (els) =>
    (els as unknown as Array<{ tagName: string; name?: string; type?: string; innerText?: string; placeholder?: string; value?: string }>).slice(0, 40).map((e) =>
      `${e.tagName.toLowerCase()}[name=${e.name || ""},type=${e.type || ""},text=${(e.innerText || e.placeholder || e.value || "").slice(0, 40)}]`,
    ),
  ).catch(() => [] as string[]);
  return [
    `url: ${url}`,
    `title: ${title}`,
    `visible-text (truncated): ${visibleText.slice(0, 2000)}`,
    `form-fields: ${formFields.join(" | ")}`,
  ].join("\n");
}

async function executePlan(page: Page, plan: StepActionPlan): Promise<{ outcome: string; status: ScoreStepStatus }> {
  try {
    switch (plan.action) {
      case "click": {
        if (!plan.selector) return { outcome: "skipped (no selector)", status: "skipped" };
        await page.locator(plan.selector).first().click({ timeout: STEP_TIMEOUT_MS });
        await page.waitForLoadState("domcontentloaded", { timeout: STEP_TIMEOUT_MS }).catch(() => {});
        return { outcome: `clicked ${plan.selector}; now at ${page.url()}`, status: "ok" };
      }
      case "fill": {
        if (!plan.selector) return { outcome: "skipped (no selector)", status: "skipped" };
        await page.locator(plan.selector).first().fill(plan.value || "", { timeout: STEP_TIMEOUT_MS });
        return { outcome: `filled ${plan.selector} with value of length ${(plan.value || "").length}`, status: "ok" };
      }
      case "navigate": {
        if (!plan.value) return { outcome: "skipped (no url)", status: "skipped" };
        await page.goto(plan.value, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
        return { outcome: `navigated to ${plan.value}`, status: "ok" };
      }
      case "assert-text": {
        if (!plan.value) return { outcome: "skipped (no text)", status: "skipped" };
        const found = await page.getByText(plan.value, { exact: false }).first().isVisible().catch(() => false);
        return found
          ? { outcome: `asserted "${plan.value.slice(0, 60)}" visible`, status: "ok" }
          : { outcome: `assertion failed: "${plan.value.slice(0, 60)}" not visible`, status: "fail" };
      }
      case "skip":
        return { outcome: plan.reason || "step deemed not driveable", status: "skipped" };
      default:
        return { outcome: `unknown action ${plan.action}`, status: "warn" };
    }
  } catch (e) {
    return { outcome: `action threw: ${(e as Error).message.slice(0, 200)}`, status: "fail" };
  }
}
