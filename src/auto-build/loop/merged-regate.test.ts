// The re-gate builds the merged base, so it builds on the packages the merged
// lockfile names. A chunk that added a package installed it in its own
// worktree; the merge brought back only package.json and the lockfile, and the
// combined build failed on a missing module (label-check's Firebase chunk,
// 2026-11-22).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopEvent } from "./types.js";

const order = vi.hoisted(() => ({
  steps: [] as string[],
  install: { ok: true, status: "ok", output: "added 5 packages" } as { ok: boolean; status: string; output: string },
}));
vi.mock("../../tool-execution/harness-exec.js", () => ({
  executeHarnessCommand: async (req: { command: string; purpose: string; opId: string }) => {
    order.steps.push(`${req.purpose}: ${req.command} (${req.opId})`);
    return order.install;
  },
}));
vi.mock("../chunk-review/gate-build-exec.js", () => ({
  runBuildExecGate: async () => { order.steps.push("build gate"); return null; },
}));

import { reGateMergedTree } from "./merged-regate.js";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "lax-regate-deps-")));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

/** A merged base whose lockfile names firebase, installed or not. */
function mergedBase(name: string, firebaseInstalled: boolean): string {
  const dir = join(BASE, name);
  mkdirSync(join(dir, "node_modules", "expo"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "^54.0.0", firebase: "^12.19.0" } }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/expo": { version: "54.0.1" }, "node_modules/firebase": { version: "12.19.0" } },
  }));
  writeFileSync(join(dir, "node_modules", "expo", "package.json"), JSON.stringify({ version: "54.0.1" }));
  if (firebaseInstalled) {
    mkdirSync(join(dir, "node_modules", "firebase"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "firebase", "package.json"), JSON.stringify({ version: "12.19.0" }));
  }
  return dir;
}

function regate(projectDir: string) {
  const events: LoopEvent[] = [];
  const emitted: Array<{ message?: string }> = [];
  const run = reGateMergedTree({
    projectDir, totalChunks: 13, waveIndex: 2, lastChunkNumber: 6, chunksCommitted: 6,
    emit: (e) => emitted.push(e), events, outcomes: [], opId: "op-label-check",
  });
  return { run, emitted };
}

describe("the integration re-gate and the merged dependencies", () => {
  beforeEach(() => {
    order.steps = [];
    order.install = { ok: true, status: "ok", output: "added 5 packages" };
  });

  it("installs what the merge added before it builds the merged tree", async () => {
    const { run, emitted } = regate(mergedBase("added", false));
    expect(await run).toEqual({ kind: "ok" });
    expect(order.steps).toEqual(["base-deps: npm ci --no-audit --no-fund (op-label-check)", "build gate"]);
    expect(emitted.map((e) => e.message).join("\n")).toContain("firebase changed");
  });

  it("builds straight away when the base already has every locked package", async () => {
    expect(await regate(mergedBase("current", true)).run).toEqual({ kind: "ok" });
    expect(order.steps).toEqual(["build gate"]);
  });

  it("halts, naming the packages and the npm error, when the install fails, and never reports a build break", async () => {
    order.install = { ok: false, status: "error", output: "npm ERR! code EBUSY\nnpm ERR! resource busy or locked" };
    const dir = mergedBase("busy", false);
    const r = await regate(dir).run;
    expect(r.kind).toBe("halt");
    const reason = r.kind === "halt" ? r.result.haltReason : "";
    expect(reason).toContain("firebase");
    expect(reason).toContain("EBUSY");
    expect(reason).toContain("npm ci");
    expect(order.steps).not.toContain("build gate");
  });
});
