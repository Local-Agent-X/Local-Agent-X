import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import {
  _setLearnedEffectivenessWriteHookForTests,
  commitLearnedOutcome,
  getVersionEffectiveness,
  listCommittedLearnedOutcomes,
  listCandidateEffectiveness,
  prepareLearnedOutcome,
  reconcilePendingLearnedOutcomes,
  type LearnedOutcome,
  type LearnedOutcomeInput,
} from "./learned-effectiveness.js";

const ORIGINAL_CONFIG = getRuntimeConfig();
let workspace = "";

function input(opId: string, outcome: LearnedOutcome = "clean", overrides: Partial<LearnedOutcomeInput> = {}): LearnedOutcomeInput {
  return {
    opId,
    sessionId: `session-${opId}`,
    slug: "learned-0123456789abcdefabcd",
    versionId: "11111111-1111-4111-8111-111111111111",
    candidateId: "learned-0123456789abcdefabcd",
    outcome,
    timestamp: 1_750_000_000_000,
    ...overrides,
  };
}

function outcomePath(opId: string): string {
  const hash = createHash("sha256").update(opId).digest("hex");
  return join(getRuntimeConfig().workspace, "protocols", "effectiveness", "outcomes", `${hash}.json`);
}

function quarantineFiles(): string[] {
  const dir = join(getRuntimeConfig().workspace, "protocols", "effectiveness", "quarantine");
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "lax-effectiveness-"));
});

beforeEach(() => {
  setRuntimeConfig({ ...ORIGINAL_CONFIG, workspace: mkdtempSync(join(workspace, "case-")) } as LAXConfig);
});

afterEach(() => {
  _setLearnedEffectivenessWriteHookForTests();
  rmSync(getRuntimeConfig().workspace, { recursive: true, force: true });
});

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CONFIG);
  rmSync(workspace, { recursive: true, force: true });
});

describe("learned effectiveness ledger", () => {
  it("keeps pending receipts out of metrics and commits idempotently by opId", () => {
    const receipt = input("op-pending");
    expect(prepareLearnedOutcome(receipt).status).toBe("pending");
    expect(prepareLearnedOutcome(receipt).status).toBe("pending");
    expect(getVersionEffectiveness(receipt.slug, receipt.versionId).total).toBe(0);

    expect(commitLearnedOutcome(receipt.opId).status).toBe("committed");
    expect(commitLearnedOutcome(receipt.opId).status).toBe("committed");
    expect(prepareLearnedOutcome(receipt).status).toBe("committed");
    expect(getVersionEffectiveness(receipt.slug, receipt.versionId).total).toBe(1);
  });

  it("rejects a conflicting identity or outcome after an op is committed", () => {
    const receipt = input("op-conflict");
    prepareLearnedOutcome(receipt);
    commitLearnedOutcome(receipt.opId);

    expect(() => prepareLearnedOutcome({ ...receipt, outcome: "aborted" })).toThrow(/Conflicting/);
    expect(() => prepareLearnedOutcome({ ...receipt, versionId: "other-version" })).toThrow(/Conflicting/);
  });

  it("persists only structural receipt fields and accepts an unknown session", () => {
    const receipt = { ...input("op-private", "clean", { sessionId: "" }), transcript: "must not persist" };
    prepareLearnedOutcome(receipt);

    const persisted = readFileSync(outcomePath(receipt.opId), "utf8");
    expect(persisted).not.toContain("transcript");
    expect(persisted).not.toContain("must not persist");
  });

  it("derives per-version metrics only from committed receipts", () => {
    const outcomes: LearnedOutcome[] = ["clean", "partial", "aborted", "clean"];
    outcomes.forEach((outcome, index) => {
      const receipt = input(`op-metric-${index}`, outcome, {
        sessionId: `session-${Math.min(index, 2)}`,
        timestamp: 1_750_000_000_000 + index,
      });
      prepareLearnedOutcome(receipt);
      commitLearnedOutcome(receipt.opId);
    });
    prepareLearnedOutcome(input("op-still-pending", "aborted"));

    expect(getVersionEffectiveness(input("x").slug, input("x").versionId)).toEqual({
      slug: input("x").slug,
      versionId: input("x").versionId,
      candidateId: input("x").candidateId,
      total: 4,
      clean: 2,
      partial: 1,
      aborted: 1,
      cleanRate: 0.5,
      partialRate: 0.25,
      abortedRate: 0.25,
      qualityScore: 0.625,
      distinctSessions: 3,
      lastOutcomeAt: 1_750_000_000_003,
    });
  });

  it("lists candidate metrics per immutable version in recency order", () => {
    const older = input("op-old", "clean", { versionId: "version-old", timestamp: 100 });
    const newer = input("op-new", "partial", { versionId: "version-new", timestamp: 200 });
    for (const receipt of [older, newer]) {
      prepareLearnedOutcome(receipt);
      commitLearnedOutcome(receipt.opId);
    }

    const listed = listCandidateEffectiveness(older.candidateId);
    expect(listed.map((entry) => entry.versionId)).toEqual(["version-new", "version-old"]);
    expect(listed.map((entry) => entry.total)).toEqual([1, 1]);
  });

  it("reads only committed receipts in deterministic chronological order", () => {
    const later = input("op-later", "partial", { timestamp: 300 });
    const earlier = input("op-earlier", "clean", { timestamp: 100 });
    const pending = input("op-pending-window", "aborted", { timestamp: 50 });
    for (const receipt of [later, earlier]) {
      prepareLearnedOutcome(receipt);
      commitLearnedOutcome(receipt.opId);
    }
    prepareLearnedOutcome(pending);

    expect(listCommittedLearnedOutcomes(later.slug, later.versionId).map((entry) => entry.opId)).toEqual([
      earlier.opId, later.opId,
    ]);
  });

  it("reconciles terminal pending receipts and retains nonterminal work", () => {
    const terminal = input("op-terminal");
    const running = input("op-running", "partial");
    prepareLearnedOutcome(terminal);
    prepareLearnedOutcome(running);

    const report = reconcilePendingLearnedOutcomes((opId) =>
      opId === terminal.opId ? { canonical: { state: "succeeded" } } : { status: "running" },
    );

    expect(report).toEqual({ committed: [terminal.opId], retained: [running.opId], quarantined: [] });
    expect(getVersionEffectiveness(terminal.slug, terminal.versionId).total).toBe(1);
  });

  it("quarantines a missing pending op only after 24 hours", () => {
    const now = 2_000_000_000_000;
    const fresh = input("op-missing-fresh", "clean", { timestamp: now - 60_000 });
    const stale = input("op-missing-stale", "clean", { timestamp: now - 25 * 60 * 60 * 1000 });
    prepareLearnedOutcome(fresh);
    prepareLearnedOutcome(stale);

    const report = reconcilePendingLearnedOutcomes(() => null, now);

    expect(report.retained).toEqual([fresh.opId]);
    expect(report.quarantined).toHaveLength(1);
    expect(existsSync(outcomePath(stale.opId))).toBe(false);
  });

  it("quarantines corrupt and filename-mismatched receipts fail-closed", () => {
    const corrupt = input("op-corrupt");
    prepareLearnedOutcome(corrupt);
    writeFileSync(outcomePath(corrupt.opId), "{broken");
    expect(() => getVersionEffectiveness(corrupt.slug, corrupt.versionId)).toThrow(/integrity/);
    expect(quarantineFiles()).toHaveLength(1);

    const dir = dirname(outcomePath("wrong-file"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "not-the-op-hash.json"), JSON.stringify({ schemaVersion: 1, status: "pending", ...input("actual-op") }));
    const report = reconcilePendingLearnedOutcomes(() => null);
    expect(report.quarantined).toHaveLength(1);
    expect(quarantineFiles()).toHaveLength(2);
  });

  it("preserves the prior receipt when an atomic update fails and reloads after restart", () => {
    const receipt = input("op-atomic");
    prepareLearnedOutcome(receipt);
    const before = readFileSync(outcomePath(receipt.opId), "utf8");
    _setLearnedEffectivenessWriteHookForTests(() => { throw new Error("injected write failure"); });

    expect(() => commitLearnedOutcome(receipt.opId)).toThrow(/injected write failure/);
    expect(readFileSync(outcomePath(receipt.opId), "utf8")).toBe(before);
    _setLearnedEffectivenessWriteHookForTests();

    setRuntimeConfig({ ...ORIGINAL_CONFIG, workspace: getRuntimeConfig().workspace } as LAXConfig);
    expect(commitLearnedOutcome(receipt.opId).status).toBe("committed");
    expect(getVersionEffectiveness(receipt.slug, receipt.versionId).total).toBe(1);
  });
});
