import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readSseUntil } from "../scripts/local-qualification/chat-evidence.js";
import { sanitizedScorecard } from "../scripts/local-qualification/cli.js";
import {
  CSS_DEFINITION_PATH,
  CSS_SYMBOL,
  FILE_NAVIGATION_DECOY_APPS,
  FILE_NAVIGATION_MAX_ACTIONS,
  FILE_NAVIGATION_SCENARIO_IDS,
  FILE_NAVIGATION_TARGET_APP,
  FOOTER_MARKER,
  fileNavigationEvidence,
  fileNavigationPrompt,
  scoreFileNavigation,
  trackFileNavigation,
  writeFileNavigationFixture,
} from "../scripts/local-qualification/file-navigation.js";
import { RealQualificationDriver } from "../scripts/local-qualification/real-driver.js";
import { runQualification } from "../scripts/local-qualification/run.js";
import type {
  CertificationResult,
  ChatResult,
  CompactionResult,
  FileNavigationResult,
  FileNavigationScenarioId,
  QualificationDriver,
  RuntimeStatus,
} from "../scripts/local-qualification/types.js";
import { FakeOllamaQualificationService } from "./helpers/fake-ollama-qualification.js";

const GOOD_ANSWERS: Record<FileNavigationScenarioId, string> = {
  find_app_by_fuzzy_name: `The app lives at workspace\\apps\\${FILE_NAVIGATION_TARGET_APP}`,
  read_file_section: `The footer reads: (c) Bella Vida Medical Massage - ${FOOTER_MARKER} - 1200 Custer Rd`,
  grep_for_symbol: `workspace/${CSS_DEFINITION_PATH}`,
};

type NavigationBehavior = (scenario: FileNavigationScenarioId, signal: AbortSignal, onProgress?: (progress: { actions: number; failedActions: number }) => void) => Promise<FileNavigationResult>;

/** Driver double: every sibling stage passes; only navigation behavior varies. */
class NavigationDriver implements QualificationDriver {
  readonly model = "qualification-fake:1b";
  readonly navigated: FileNavigationScenarioId[] = [];
  private verified = false;
  private certCalls = 0;

  constructor(private readonly behavior: NavigationBehavior) {}

  forbiddenRequests(): number { return 0; }
  async start(): Promise<void> {}
  async status(): Promise<RuntimeStatus> {
    return { found: true, verified: this.verified, runtimeId: "ollama@127.0.0.1:1", digest: "sha256:test", certificationCalls: this.certCalls };
  }
  async certify(): Promise<CertificationResult> {
    this.verified = true;
    this.certCalls = 5;
    return {
      ok: true, operatorGuarded: true, passedCount: 5, scenarioCount: 5, callCount: 5,
      scenarioIds: ["baseline_marker", "strict_json_schema", "required_tool_call", "tool_result_continuation", "context_degradation"],
    };
  }
  async chat(kind: "baseline" | "workspace-read" | "history" | "continuity"): Promise<ChatResult> {
    return {
      done: true, hasText: true, errorEvents: 0, safeReadLifecycle: kind === "workspace-read",
      forbiddenControlEvents: 0, readNonceSeen: kind === "workspace-read", continuityMarkerSeen: kind === "continuity",
    };
  }
  navigate(scenario: FileNavigationScenarioId, signal: AbortSignal, onProgress?: (progress: { actions: number; failedActions: number }) => void): Promise<FileNavigationResult> {
    this.navigated.push(scenario);
    return this.behavior(scenario, signal, onProgress);
  }
  async compact(): Promise<CompactionResult> {
    return { ok: true, backgroundRequests: 1, persistedMessageCount: 12, persistedSummary: true, summaryIsLeading: true, summaryContainsMarker: true };
  }
  async persistedSummary(): Promise<{ persisted: boolean; containsMarker: boolean }> {
    return { persisted: true, containsMarker: true };
  }
  async restart(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

function answer(scenario: FileNavigationScenarioId, actions = 3, failedActions = 1): FileNavigationResult {
  return { done: true, errorEvents: 0, finalText: GOOD_ANSWERS[scenario], actions, failedActions, capped: false };
}

function sseResponse(events: Array<Record<string, unknown>>, onCancel: () => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= events.length) { controller.close(); return; }
      // Split one frame across two chunks so the reader must buffer partial frames.
      const frame = `data: ${JSON.stringify(events[index])}\n\n`;
      controller.enqueue(encoder.encode(frame.slice(0, 7)));
      controller.enqueue(encoder.encode(frame.slice(7)));
      index += 1;
    },
    cancel() { onCancel(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function toolLifecycle(count: number, failEvery = 0): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (let n = 1; n <= count; n += 1) {
    events.push({ type: "tool_start", toolName: "glob", toolCallId: `call-${n}`, args: {} });
    events.push({ type: "tool_end", toolName: "glob", toolCallId: `call-${n}`, allowed: true, status: failEvery && n % failEvery === 0 ? "error" : "ok" });
  }
  return events;
}

describe("file_navigation fixture, prompts, and scoring", () => {
  it("creates three look-alike apps where only the target carries the footer marker and the symbol definition", () => {
    const workspace = mkdtempSync(join(tmpdir(), "lax-navigation-fixture-"));
    try {
      writeFileNavigationFixture(workspace);
      const apps = readdirSync(join(workspace, "apps")).sort();
      expect(apps).toEqual([FILE_NAVIGATION_TARGET_APP, ...FILE_NAVIGATION_DECOY_APPS].sort());
      for (const app of apps) {
        const html = readFileSync(join(workspace, "apps", app, "index.html"), "utf8");
        const css = readFileSync(join(workspace, "apps", app, "css", "site.css"), "utf8");
        expect(html).toMatch(/<footer[\s\S]*<\/footer>/);
        expect(html.includes(FOOTER_MARKER)).toBe(app === FILE_NAVIGATION_TARGET_APP);
        expect(css.includes(`.${CSS_SYMBOL} {`)).toBe(app === FILE_NAVIGATION_TARGET_APP);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the answers out of every prompt", () => {
    for (const scenario of FILE_NAVIGATION_SCENARIO_IDS) {
      const prompt = fileNavigationPrompt(scenario);
      expect(prompt).not.toContain(FILE_NAVIGATION_TARGET_APP);
      expect(prompt).not.toContain(FOOTER_MARKER);
      expect(prompt).not.toContain("site.css");
    }
    expect(fileNavigationPrompt("find_app_by_fuzzy_name")).toContain("bellavidamassage clone");
    expect(fileNavigationPrompt("grep_for_symbol")).toContain(CSS_SYMBOL);
  });

  it("scores the marker or the correct path and rejects decoys", () => {
    for (const scenario of FILE_NAVIGATION_SCENARIO_IDS) expect(scoreFileNavigation(scenario, GOOD_ANSWERS[scenario])).toBe(true);
    expect(scoreFileNavigation("find_app_by_fuzzy_name", `apps/${FILE_NAVIGATION_DECOY_APPS[0]}`)).toBe(false);
    expect(scoreFileNavigation("find_app_by_fuzzy_name", `${FILE_NAVIGATION_TARGET_APP} or ${FILE_NAVIGATION_DECOY_APPS[1]}`)).toBe(false);
    expect(scoreFileNavigation("read_file_section", "The footer says LAX_QUALIFICATION_DECOY_51B0")).toBe(false);
    expect(scoreFileNavigation("read_file_section", `${FOOTER_MARKER} and LAX_QUALIFICATION_DECOY_C7E4`)).toBe(false);
    expect(scoreFileNavigation("grep_for_symbol", `apps/${FILE_NAVIGATION_DECOY_APPS[0]}/css/site.css`)).toBe(false);
    expect(scoreFileNavigation("grep_for_symbol", "site.css")).toBe(false);
    expect(scoreFileNavigation("grep_for_symbol", `C:\\x\\workspace\\apps\\${FILE_NAVIGATION_TARGET_APP}\\css\\site.css`)).toBe(true);
  });
});

describe("file_navigation driver-side action cap", () => {
  it("counts actions and failed actions from the tool lifecycle", () => {
    const events = [...toolLifecycle(5, 2), { type: "stream", delta: "answer" }, { type: "done", usage: {} }];
    expect(fileNavigationEvidence(events, false)).toEqual({
      done: true, errorEvents: 0, finalText: "answer", actions: 5, failedActions: 2, capped: false,
    });
  });

  it("cancels the stream at the thirteenth tool call instead of reading a wandering turn to the end", async () => {
    let cancelled = false;
    const progress: Array<{ actions: number; failedActions: number }> = [];
    const tracker = trackFileNavigation((next) => progress.push(next));
    const response = sseResponse([...toolLifecycle(40), { type: "stream", delta: "late" }, { type: "done", usage: {} }], () => { cancelled = true; });
    const { events, stopped } = await readSseUntil(response, (event) => tracker.onEvent(event));
    expect(stopped).toBe(true);
    expect(cancelled).toBe(true);
    expect(tracker.capped).toBe(true);
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(FILE_NAVIGATION_MAX_ACTIONS + 1);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(progress.at(-1)).toEqual({ actions: FILE_NAVIGATION_MAX_ACTIONS + 1, failedActions: 0 });
    const evidence = fileNavigationEvidence(events, stopped);
    expect(evidence).toMatchObject({ done: false, capped: true, actions: FILE_NAVIGATION_MAX_ACTIONS + 1, finalText: "" });
  });

  it("reads a complete stream across chunk boundaries without cancelling", async () => {
    let cancelled = false;
    const tracker = trackFileNavigation();
    const response = sseResponse([...toolLifecycle(3), { type: "stream", delta: "a" }, { type: "stream", delta: "b" }, { type: "done", usage: {} }], () => { cancelled = true; });
    const { events, stopped } = await readSseUntil(response, (event) => tracker.onEvent(event));
    expect(stopped).toBe(false);
    expect(cancelled).toBe(false);
    expect(fileNavigationEvidence(events, stopped)).toMatchObject({ done: true, actions: 3, finalText: "ab", capped: false });
  });
});

describe("file_navigation stage", () => {
  it("passes all three scenarios and records action counts as scorecard evidence that survives JSON", async () => {
    const driver = new NavigationDriver(async (scenario) => answer(scenario, scenario === "grep_for_symbol" ? 1 : 3, scenario === "find_app_by_fuzzy_name" ? 1 : 0));
    const scorecard = await runQualification(driver);
    expect(scorecard.ok).toBe(true);
    expect(driver.navigated).toEqual([...FILE_NAVIGATION_SCENARIO_IDS]);
    const stage = scorecard.stages.find((item) => item.name === "file_navigation");
    expect(stage).toMatchObject({ ok: true });
    expect(stage?.scenarios?.map(({ id, ok, actions, failedActions }) => ({ id, ok, actions, failedActions }))).toEqual([
      { id: "find_app_by_fuzzy_name", ok: true, actions: 3, failedActions: 1 },
      { id: "read_file_section", ok: true, actions: 3, failedActions: 0 },
      { id: "grep_for_symbol", ok: true, actions: 1, failedActions: 0 },
    ]);
    expect(scorecard.stages.filter((item) => item.name !== "file_navigation").every((item) => item.scenarios === undefined)).toBe(true);
    const sanitized = sanitizedScorecard(scorecard);
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual(sanitized);
    expect(sanitized.stages.find((item) => item.name === "file_navigation")?.scenarios).toEqual(stage?.scenarios);
    expect(JSON.stringify(sanitized)).not.toMatch(new RegExp(`${FOOTER_MARKER}|footer reads|prompt|finalText`, "i"));
  });

  it("fails a scenario that wanders past the action cap and reports it on the stage", async () => {
    const driver = new NavigationDriver(async (scenario) => scenario === "read_file_section"
      ? { done: false, errorEvents: 0, finalText: "", actions: 13, failedActions: 4, capped: true }
      : answer(scenario));
    const scorecard = await runQualification(driver);
    expect(scorecard.ok).toBe(false);
    expect(driver.navigated).toEqual([...FILE_NAVIGATION_SCENARIO_IDS]);
    const stage = scorecard.stages.at(-1);
    expect(stage).toMatchObject({ name: "file_navigation", ok: false, failure: "failed" });
    expect(stage?.scenarios).toEqual([
      expect.objectContaining({ id: "find_app_by_fuzzy_name", ok: true, actions: 3 }),
      expect.objectContaining({ id: "read_file_section", ok: false, failure: "failed", actions: 13, failedActions: 4 }),
      expect.objectContaining({ id: "grep_for_symbol", ok: true, actions: 3 }),
    ]);
  });

  it("fails a correct answer that took more than the cap, so a slow-but-right model is still a regression", async () => {
    const driver = new NavigationDriver(async (scenario) => answer(scenario, scenario === "find_app_by_fuzzy_name" ? 15 : 2, 2));
    const scorecard = await runQualification(driver);
    expect(scorecard.stages.at(-1)?.scenarios?.[0]).toMatchObject({ id: "find_app_by_fuzzy_name", ok: false, failure: "failed", actions: 15, failedActions: 2 });
  });

  it("fails a wrong final answer even when the tool work looked healthy", async () => {
    const driver = new NavigationDriver(async (scenario) => scenario === "grep_for_symbol"
      ? { done: true, errorEvents: 0, finalText: `apps/${FILE_NAVIGATION_DECOY_APPS[1]}/css/site.css`, actions: 2, failedActions: 0, capped: false }
      : answer(scenario));
    const scorecard = await runQualification(driver);
    expect(scorecard.stages.at(-1)).toMatchObject({ name: "file_navigation", failure: "failed" });
    expect(scorecard.stages.at(-1)?.scenarios?.at(-1)).toMatchObject({ id: "grep_for_symbol", ok: false, actions: 2 });
  });

  it("times out one hanging scenario, keeps the actions it had already taken, and still runs the rest", async () => {
    const driver = new NavigationDriver((scenario, signal, onProgress) => {
      if (scenario !== "read_file_section") return Promise.resolve(answer(scenario));
      onProgress?.({ actions: 4, failedActions: 1 });
      onProgress?.({ actions: 5, failedActions: 1 });
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const scorecard = await runQualification(driver, { scenarioTimeoutMs: 20 });
    const stage = scorecard.stages.at(-1);
    // The only failure was a timeout, so the stage reports a timeout, not a generic failure.
    expect(stage).toMatchObject({ name: "file_navigation", ok: false, failure: "timeout" });
    expect(stage?.scenarios?.map(({ id, ok, failure, actions, failedActions }) => ({ id, ok, failure, actions, failedActions }))).toEqual([
      { id: "find_app_by_fuzzy_name", ok: true, failure: undefined, actions: 3, failedActions: 1 },
      { id: "read_file_section", ok: false, failure: "timeout", actions: 5, failedActions: 1 },
      { id: "grep_for_symbol", ok: true, failure: undefined, actions: 3, failedActions: 1 },
    ]);
  });

  it("reports the stage as a timeout when every scenario timed out", async () => {
    const driver = new NavigationDriver((_scenario, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const scorecard = await runQualification(driver, { scenarioTimeoutMs: 10 });
    const stage = scorecard.stages.at(-1);
    expect(stage).toMatchObject({ name: "file_navigation", ok: false, failure: "timeout" });
    expect(stage?.scenarios?.every((scenario) => scenario.failure === "timeout")).toBe(true);
    expect(stage?.scenarios).toHaveLength(3);
  });

  it("stops at the first scenario on an operator abort", async () => {
    const controller = new AbortController();
    const driver = new NavigationDriver((_scenario, signal) => {
      setTimeout(() => controller.abort(), 5);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const scorecard = await runQualification(driver, { signal: controller.signal });
    expect(scorecard.stages.at(-1)).toMatchObject({ name: "file_navigation", failure: "aborted" });
    expect(driver.navigated).toEqual(["find_app_by_fuzzy_name"]);
    expect(scorecard.stages.at(-1)?.scenarios).toEqual([]);
  });

  // These drive the real driver's navigate() DIRECTLY rather than through
  // runQualification: the stage runs after chat_sse/workspace_read, so a
  // regression in those unrelated stages would otherwise mask this one.
  async function withRealDriver(
    navigation: "answer" | "wander",
    run: (driver: RealQualificationDriver, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const service = new FakeOllamaQualificationService();
    service.navigation = navigation;
    const endpoint = await service.start();
    const signal = new AbortController().signal;
    let ownedRoot = "";
    const driver = new RealQualificationDriver(endpoint, service.model, resolve("."), {
      onOwnedRoot: (path) => { ownedRoot = path; },
    });
    try {
      await driver.start(signal);
      await run(driver, signal);
      expect(service.counts.forbidden).toBe(0);
    } finally {
      await driver.cleanup(signal);
      await service.close();
    }
    expect(existsSync(ownedRoot)).toBe(false);
  }

  it("finds, reads, and greps the fixture through the actual product tools", async () => {
    await withRealDriver("answer", async (driver, signal) => {
      for (const scenario of FILE_NAVIGATION_SCENARIO_IDS) {
        const result = await driver.navigate(scenario, signal);
        expect(result, `${scenario}: ${JSON.stringify(result)}`).toMatchObject({ done: true, errorEvents: 0, capped: false });
        expect(result.actions, scenario).toBeGreaterThan(0);
        expect(result.actions, scenario).toBeLessThanOrEqual(FILE_NAVIGATION_MAX_ACTIONS);
        expect(scoreFileNavigation(scenario, result.finalText), `${scenario}: ${result.finalText}`).toBe(true);
      }
    });
  }, 300_000);

  it("bounds a wandering local model at the action cap instead of hanging", async () => {
    await withRealDriver("wander", async (driver, signal) => {
      const progress: Array<{ actions: number; failedActions: number }> = [];
      const result = await driver.navigate("find_app_by_fuzzy_name", signal, (next) => progress.push(next));
      expect(result.capped).toBe(true);
      expect(result.done).toBe(false);
      expect(result.actions).toBe(FILE_NAVIGATION_MAX_ACTIONS + 1);
      expect(progress.at(-1)?.actions).toBe(FILE_NAVIGATION_MAX_ACTIONS + 1);
      expect(scoreFileNavigation("find_app_by_fuzzy_name", result.finalText)).toBe(false);
    });
  }, 300_000);
});
