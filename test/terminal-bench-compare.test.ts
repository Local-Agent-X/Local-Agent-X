import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs eval module, no type declarations
import { compareSides, mcnemarExact, readJob, scoreSide } from "../eval/terminal-bench/compare.mjs";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A Harbor job dir: one trial dir per [task, reward|null] (null = the verifier never ran). */
function job(trials: Array<[string, number | null]>): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-job-"));
  dirs.push(dir);
  trials.forEach(([task, reward], i) => {
    const t = join(dir, `${task}__t${i}`);
    mkdirSync(t);
    writeFileSync(join(t, "result.json"), JSON.stringify({
      task_name: task,
      verifier_result: reward === null ? null : { rewards: { reward } },
      // A trial that timed out can still pass: the reward decides, never this.
      exception_info: { exception_type: "AgentTimeoutError" },
    }));
  });
  writeFileSync(join(dir, "result.json"), "{}");
  return dir;
}

describe("terminal-bench compare", () => {
  it("scores by the verifier's reward and leaves trials with no verdict out of the rate", () => {
    const s = scoreSide(readJob(job([["a", 1], ["b", 0], ["c", null]])));
    expect(s).toMatchObject({ tasks: 2, passed: 1, rate: 0.5, noVerdict: ["c"] });
  });

  it("makes the task the unit when a task has several attempts", () => {
    const s = scoreSide(readJob(job([["a", 1], ["a", 0], ["b", 1], ["b", 1]])));
    expect(s).toMatchObject({ tasks: 2, passed: 1.5, rate: 0.75, passedOnce: 2, attempts: { min: 2, max: 2 } });
  });

  it("calls a one-task lead out of 89 noise, and a large paired lead real", () => {
    const tasks = Array.from({ length: 89 }, (_, i) => `t${i}`);
    const close = compareSides(
      scoreSide(tasks.map((t, i) => ({ task: t, reward: i < 52 ? 1 : 0 }))),
      scoreSide(tasks.map((t, i) => ({ task: t, reward: i < 51 ? 1 : 0 }))),
    );
    expect(close).toMatchObject({ common: 89, onlyA: ["t51"], onlyB: [], withinNoise: true });
    expect(close.mcnemarP).toBe(1);

    const far = compareSides(
      scoreSide(tasks.map((t, i) => ({ task: t, reward: i < 70 ? 1 : 0 }))),
      scoreSide(tasks.map((t, i) => ({ task: t, reward: i < 40 ? 1 : 0 }))),
    );
    expect(far.withinNoise).toBe(false);
    expect(far.mcnemarP).toBeLessThan(0.001);
  });

  it("computes the exact two-sided McNemar p-value", () => {
    // 11 vs 9 discordant pairs: 2 * P(X <= 9 | n = 20, p = 1/2) = 0.8238
    expect(mcnemarExact(11, 9)).toBeCloseTo(0.8238, 3);
    expect(mcnemarExact(0, 0)).toBe(1);
  });
});
