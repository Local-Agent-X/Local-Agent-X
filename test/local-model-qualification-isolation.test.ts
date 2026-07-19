import { existsSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isPidAlive } from "../src/pid-probe.js";
import type { LifecycleBarrierName } from "../scripts/local-qualification/lifecycle-helpers.js";
import { RealQualificationDriver } from "../scripts/local-qualification/real-driver.js";
import { runQualification } from "../scripts/local-qualification/run.js";
import { QUALIFICATION_STAGES, type QualificationStageName } from "../scripts/local-qualification/types.js";
import { FakeOllamaQualificationService } from "./helpers/fake-ollama-qualification.js";
import { FailingRealQualificationDriver } from "./helpers/failing-real-qualification-driver.js";
import {
  createQualificationRepoFixture,
  type WorkspaceLayout,
} from "./helpers/qualification-repo-fixture.js";

const LAYOUTS: WorkspaceLayout[] = ["absent", "empty", "populated", "junction"];
const FAILURE_CASES = QUALIFICATION_STAGES.flatMap((stage) => (
  LAYOUTS.map((layout) => [stage, layout] as const)
));
const INTERRUPTION_CASES = (["timeout", "abort"] as const).flatMap((mode) => (
  LAYOUTS.map((layout) => [mode, layout] as const)
));
const REAL_REPO = resolve(".");
const DEPENDENCY_ROOT = resolve(REAL_REPO, "..", "..");
const TSX_IMPORT = pathToFileURL(resolve(DEPENDENCY_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

function barrier() {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolveEntered) => { enteredResolve = resolveEntered; });
  const released = new Promise<void>((resolveReleased) => { releaseResolve = resolveReleased; });
  return {
    entered,
    release: releaseResolve,
    wait: async (signal: AbortSignal) => {
      enteredResolve();
      await new Promise<void>((resolveWait, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void released.then(() => {
          signal.removeEventListener("abort", abort);
          resolveWait();
        });
      });
    },
  };
}

async function expectPortClosed(url: string): Promise<void> {
  await expect(new Promise<void>((resolveRequest, reject) => {
    const pending = request(url, { timeout: 500 }, () => reject(new Error("port remained open")));
    pending.once("error", () => resolveRequest());
    pending.once("timeout", () => { pending.destroy(); resolveRequest(); });
    pending.end();
  })).resolves.toBeUndefined();
}

async function expectPidDead(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (isPidAlive(pid) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  expect(isPidAlive(pid)).toBe(false);
}

function observedOptions(
  state: { root: string; proxyUrl: string; pid: number },
  barriers?: Partial<Record<LifecycleBarrierName, (signal: AbortSignal) => Promise<void>>>,
) {
  return {
    onOwnedRoot: (path: string) => { state.root = path; },
    onProxyUrl: (url: string) => { state.proxyUrl = url; },
    onChildSpawn: (pid: number) => { state.pid = pid; },
    childStdio: "ignore" as const,
    tsxImport: TSX_IMPORT,
    barriers,
  };
}

describe("actual-product qualification isolation", () => {
  it.each(LAYOUTS)("keeps the %s repository surface exact across success and restart", async (layout) => {
    const fixture = createQualificationRepoFixture(REAL_REPO, layout, DEPENDENCY_ROOT);
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    let ownedRoot = "";
    const before = fixture.snapshot();
    try {
      const driver = new RealQualificationDriver(endpoint, service.model, fixture.root, {
        onOwnedRoot: (path) => { ownedRoot = path; },
        childStdio: "ignore",
        tsxImport: TSX_IMPORT,
      });
      const scorecard = await runQualification(driver, { stageTimeoutMs: 90_000 });
      expect(scorecard.ok, JSON.stringify(scorecard)).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
      expect(existsSync(ownedRoot)).toBe(false);
    } finally {
      await service.close();
      fixture.cleanup();
    }
  }, 180_000);

  it.each(FAILURE_CASES)("preserves a %s failure with a %s repository workspace", async (stage, layout) => {
    const fixture = createQualificationRepoFixture(REAL_REPO, layout, DEPENDENCY_ROOT);
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    const state = { root: "", proxyUrl: "", pid: 0 };
    const before = fixture.snapshot();
    try {
      const driver = new FailingRealQualificationDriver(
        endpoint, service.model, fixture.root, observedOptions(state), stage,
      );
      const scorecard = await runQualification(driver, { stageTimeoutMs: 90_000 });
      expect(scorecard.stages.at(-1)).toMatchObject({ name: stage, failure: "failed" });
      expect(scorecard.cleanup.ok).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
      expect(existsSync(state.root)).toBe(false);
      await expectPidDead(state.pid);
      await expectPortClosed(state.proxyUrl);
    } finally {
      await service.close();
      fixture.cleanup();
    }
  }, 180_000);

  it.each(LAYOUTS)("preserves a %s repository workspace after forbidden proxy traffic", async (layout) => {
    const fixture = createQualificationRepoFixture(REAL_REPO, layout, DEPENDENCY_ROOT);
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    const state = { root: "", proxyUrl: "", pid: 0 };
    const before = fixture.snapshot();
    class ForbiddenRouteDriver extends RealQualificationDriver {
      override async start(signal: AbortSignal): Promise<void> {
        await super.start(signal);
        const response = await fetch(`${state.proxyUrl}/api/pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        });
        expect(response.status).toBe(403);
      }
    }
    try {
      const driver = new ForbiddenRouteDriver(
        endpoint, service.model, fixture.root, observedOptions(state),
      );
      const scorecard = await runQualification(driver, { stageTimeoutMs: 90_000 });
      expect(scorecard.stages[0]).toMatchObject({ name: "isolated_boot", failure: "failed" });
      expect(driver.forbiddenRequests()).toBe(1);
      expect(service.counts.forbidden).toBe(0);
      expect(scorecard.cleanup.ok).toBe(true);
      expect(fixture.snapshot()).toEqual(before);
      expect(existsSync(state.root)).toBe(false);
      await expectPidDead(state.pid);
      await expectPortClosed(state.proxyUrl);
    } finally {
      await service.close();
      fixture.cleanup();
    }
  }, 180_000);

  it.each(INTERRUPTION_CASES)("drains a blocked spawned lifecycle before %s cleanup with a %s workspace", async (mode, layout) => {
    const fixture = createQualificationRepoFixture(REAL_REPO, layout, DEPENDENCY_ROOT);
    const service = new FakeOllamaQualificationService();
    const endpoint = await service.start();
    const gate = barrier();
    const state = { root: "", proxyUrl: "", pid: 0 };
    const before = fixture.snapshot();
    const controller = new AbortController();
    try {
      const driver = new RealQualificationDriver(endpoint, service.model, fixture.root, observedOptions(state, {
        health: gate.wait,
      }));
      const running = runQualification(driver, {
        signal: controller.signal,
        stageTimeoutMs: mode === "timeout" ? 1_000 : 90_000,
      });
      await gate.entered;
      if (mode === "abort") controller.abort();
      const scorecard = await running;
      expect(scorecard.stages[0]).toMatchObject({ name: "isolated_boot", failure: mode === "timeout" ? "timeout" : "aborted" });
      expect(scorecard.cleanup.ok).toBe(true);
      const forbidden = driver.forbiddenRequests();
      expect(fixture.snapshot()).toEqual(before);
      expect(existsSync(state.root)).toBe(false);
      await expectPidDead(state.pid);
      await expectPortClosed(state.proxyUrl);
      gate.release();
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      expect(existsSync(state.root)).toBe(false);
      expect(driver.forbiddenRequests()).toBe(forbidden);
      expect(fixture.snapshot()).toEqual(before);
    } finally {
      gate.release();
      await service.close();
      fixture.cleanup();
    }
  }, 180_000);
});
