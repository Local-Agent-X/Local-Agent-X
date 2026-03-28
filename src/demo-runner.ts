/**
 * Demo Script Runner
 *
 * Runs pre-scripted demos deterministically for
 * reproducible recordings and YouTube content.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DemoRecorder } from "./demo-recorder.js";
import type { Recording } from "./demo-recorder.js";

export type DemoStepType = "message" | "wait" | "assert" | "screenshot" | "narrate";

export interface DemoStep {
  type: DemoStepType;
  data: Record<string, unknown>;
  delayMs?: number;
}

export interface DemoScript {
  name: string;
  description: string;
  steps: DemoStep[];
}

export interface DemoRunOptions {
  speed: number;
  onStep?: (step: DemoStep, index: number, total: number) => void | Promise<void>;
  autoRecord: boolean;
  sendMessage?: (content: string) => Promise<string>;
  captureScreenshot?: () => Promise<string>;
}

export interface DemoRunResult {
  script: string;
  startedAt: string;
  duration: number;
  stepsCompleted: number;
  stepsTotal: number;
  passed: boolean;
  failures: string[];
  recording: Recording | null;
}

const SCRIPTS_DIR = join(homedir(), ".sax", "demo-scripts");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Built-in demo scripts

const HELLO_WORLD_SCRIPT: DemoScript = {
  name: "hello-world",
  description: "Basic chat showing agent personality and memory",
  steps: [
    { type: "narrate", data: { text: "Starting a basic conversation with the agent" } },
    { type: "wait", data: {}, delayMs: 1000 },
    { type: "message", data: { content: "Hey, what's your name and what can you do?" } },
    { type: "wait", data: {}, delayMs: 2000 },
    { type: "assert", data: { contains: "Agent" } },
    { type: "narrate", data: { text: "Testing memory recall" } },
    { type: "message", data: { content: "Remember that my favorite color is blue." } },
    { type: "wait", data: {}, delayMs: 1500 },
    { type: "message", data: { content: "What's my favorite color?" } },
    { type: "wait", data: {}, delayMs: 1500 },
    { type: "assert", data: { contains: "blue" } },
    { type: "narrate", data: { text: "Agent successfully recalled stored information" } },
  ],
};

const BROWSER_TASK_SCRIPT: DemoScript = {
  name: "browser-task",
  description: "Open a website, extract info, and summarize",
  steps: [
    { type: "narrate", data: { text: "Demonstrating browser automation capabilities" } },
    { type: "wait", data: {}, delayMs: 1000 },
    { type: "message", data: { content: "Open https://news.ycombinator.com and tell me the top 3 stories" } },
    { type: "wait", data: {}, delayMs: 5000 },
    { type: "screenshot", data: { label: "hacker-news-loaded" } },
    { type: "assert", data: { contains: "1." } },
    { type: "narrate", data: { text: "Agent extracted and summarized content from the page" } },
    { type: "message", data: { content: "Click on the first story and summarize the discussion" } },
    { type: "wait", data: {}, delayMs: 5000 },
    { type: "screenshot", data: { label: "story-discussion" } },
    { type: "narrate", data: { text: "Browser task completed successfully" } },
  ],
};

const MISSION_RUN_SCRIPT: DemoScript = {
  name: "mission-run",
  description: "Execute the Instagram posting mission end-to-end",
  steps: [
    { type: "narrate", data: { text: "Running the Instagram posting mission" } },
    { type: "wait", data: {}, delayMs: 1000 },
    { type: "message", data: { content: "List available missions" } },
    { type: "wait", data: {}, delayMs: 2000 },
    { type: "screenshot", data: { label: "missions-list" } },
    { type: "message", data: { content: "Run the Instagram posting mission" } },
    { type: "wait", data: {}, delayMs: 3000 },
    { type: "narrate", data: { text: "Mission is generating content and preparing the post" } },
    { type: "wait", data: {}, delayMs: 10000 },
    { type: "screenshot", data: { label: "mission-progress" } },
    { type: "narrate", data: { text: "Checking mission completion status" } },
    { type: "message", data: { content: "What's the status of the mission?" } },
    { type: "wait", data: {}, delayMs: 3000 },
    { type: "screenshot", data: { label: "mission-complete" } },
    { type: "narrate", data: { text: "Instagram posting mission completed" } },
  ],
};

const BUILT_IN_SCRIPTS: Map<string, DemoScript> = new Map([
  ["hello-world", HELLO_WORLD_SCRIPT],
  ["browser-task", BROWSER_TASK_SCRIPT],
  ["mission-run", MISSION_RUN_SCRIPT],
]);

export class DemoRunner {
  private paused = false;
  private running = false;
  private resumeResolve: (() => void) | null = null;
  private recorder: DemoRecorder | null = null;
  private lastResponse = "";

  loadScript(path: string): DemoScript {
    if (BUILT_IN_SCRIPTS.has(path)) {
      return BUILT_IN_SCRIPTS.get(path)!;
    }
    if (!existsSync(path)) {
      const scriptPath = join(SCRIPTS_DIR, `${path}.json`);
      if (!existsSync(scriptPath)) {
        throw new Error(`Script not found: ${path}`);
      }
      return JSON.parse(readFileSync(scriptPath, "utf-8")) as DemoScript;
    }
    return JSON.parse(readFileSync(path, "utf-8")) as DemoScript;
  }

  async runScript(script: DemoScript, options?: Partial<DemoRunOptions>): Promise<DemoRunResult> {
    const opts: DemoRunOptions = {
      speed: 1.0,
      autoRecord: true,
      ...options,
    };

    this.running = true;
    this.paused = false;
    this.lastResponse = "";

    if (opts.autoRecord) {
      this.recorder = new DemoRecorder();
      this.recorder.startRecording(`demo-${script.name}`, {
        scriptName: script.name,
        description: script.description,
        speed: opts.speed,
      });
    }

    const startTime = Date.now();
    const failures: string[] = [];
    let stepsCompleted = 0;

    for (let i = 0; i < script.steps.length; i++) {
      if (!this.running) {
        break;
      }

      if (this.paused) {
        await this.waitForResume();
      }

      const step = script.steps[i];

      if (opts.onStep) {
        await opts.onStep(step, i, script.steps.length);
      }

      const stepDelay = step.delayMs ? Math.round(step.delayMs / opts.speed) : 0;

      try {
        switch (step.type) {
          case "message": {
            const content = String(step.data.content ?? "");
            this.recorder?.recordUserMessage(content);
            if (opts.sendMessage) {
              const response = await opts.sendMessage(content);
              this.lastResponse = response;
              this.recorder?.recordAssistantResponse(response);
            }
            break;
          }

          case "wait": {
            if (stepDelay > 0) {
              await sleep(stepDelay);
            }
            break;
          }

          case "assert": {
            const expected = String(step.data.contains ?? "");
            const caseInsensitive = Boolean(step.data.caseInsensitive);
            const haystack = caseInsensitive ? this.lastResponse.toLowerCase() : this.lastResponse;
            const needle = caseInsensitive ? expected.toLowerCase() : expected;
            if (!haystack.includes(needle)) {
              const msg = `Assertion failed at step ${i + 1}: expected response to contain "${expected}"`;
              failures.push(msg);
              this.recorder?.recordError(msg);
            }
            break;
          }

          case "screenshot": {
            const label = String(step.data.label ?? `step-${i + 1}`);
            if (opts.captureScreenshot) {
              const screenshotPath = await opts.captureScreenshot();
              this.recorder?.addEvent({
                timestamp: Date.now() - startTime,
                type: "system",
                data: { action: "screenshot", label, path: screenshotPath },
              });
            }
            break;
          }

          case "narrate": {
            const text = String(step.data.text ?? "");
            this.recorder?.addEvent({
              timestamp: Date.now() - startTime,
              type: "system",
              data: { action: "narrate", text },
            });
            break;
          }
        }

        stepsCompleted++;

        if (step.type !== "wait" && stepDelay > 0) {
          await sleep(stepDelay);
        }
      } catch (err) {
        const msg = `Step ${i + 1} (${step.type}) failed: ${err instanceof Error ? err.message : String(err)}`;
        failures.push(msg);
        this.recorder?.recordError(msg);
        stepsCompleted++;
      }
    }

    const duration = Date.now() - startTime;
    let recording: Recording | null = null;

    if (this.recorder) {
      this.recorder.stopRecording();
      recording = this.recorder.getRecording();
      try {
        this.recorder.saveRecording();
      } catch {
        // Non-critical if save fails
      }
    }

    this.running = false;

    return {
      script: script.name,
      startedAt: new Date(startTime).toISOString(),
      duration,
      stepsCompleted,
      stepsTotal: script.steps.length,
      passed: failures.length === 0,
      failures,
      recording,
    };
  }

  pauseScript(): void {
    if (this.running) {
      this.paused = true;
    }
  }

  resumeScript(): void {
    if (this.paused && this.resumeResolve) {
      this.paused = false;
      this.resumeResolve();
      this.resumeResolve = null;
    }
  }

  stopScript(): void {
    this.running = false;
    this.paused = false;
    if (this.resumeResolve) {
      this.resumeResolve();
      this.resumeResolve = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getRecorder(): DemoRecorder | null {
    return this.recorder;
  }

  static listBuiltInScripts(): DemoScript[] {
    return Array.from(BUILT_IN_SCRIPTS.values());
  }

  static listCustomScripts(): string[] {
    ensureDir(SCRIPTS_DIR);
    return readdirSync(SCRIPTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(SCRIPTS_DIR, f));
  }

  static saveScript(script: DemoScript, filename?: string): string {
    ensureDir(SCRIPTS_DIR);
    const name = filename ?? `${script.name}.json`;
    const target = join(SCRIPTS_DIR, name);
    writeFileSync(target, JSON.stringify(script, null, 2), "utf-8");
    return target;
  }

  private waitForResume(): Promise<void> {
    return new Promise((resolve) => {
      this.resumeResolve = resolve;
    });
  }
}
