/**
 * AM-8 regression — the always-on trust signal must not inject a fabricated
 * conversation-count fact.
 *
 * conversationCount is never incremented (recordConversation has no callers),
 * so getRelationshipStage() used to emit "… 0 conversations." on every turn:
 * a persistent, wrong, self-describing fact fed to the model. The stage text
 * must describe the relationship without asserting an untracked count.
 *
 * Isolated via a per-test LAX_DATA_DIR so we never touch real state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let origDataDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "trust-stage-test-"));
  origDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tempDir;
  vi.resetModules(); // force the module to re-capture LAX_DIR from the fresh env
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = origDataDir;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Seed the trust store on disk so the engine loads a known state. */
function seedStore(store: Record<string, unknown>): void {
  writeFileSync(join(tempDir, "trust-engine.json"), JSON.stringify(store), "utf-8");
}

async function stage(): Promise<string> {
  const { TrustEngine } = await import("../src/trust-deepening.js");
  TrustEngine.reset();
  return TrustEngine.getInstance().getRelationshipStage();
}

describe("TrustEngine.getRelationshipStage — no fabricated conversation count", () => {
  it("does not assert a conversation count for a fresh (new) relationship", async () => {
    const s = await stage();
    expect(s).not.toMatch(/conversation/i);
  });

  it("does not assert '0 conversations' at the familiar stage (the cited case)", async () => {
    // firstSeen 10 days ago, no signals, count untracked → level "familiar".
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    seedStore({
      firstSeen: tenDaysAgo,
      signals: [],
      conversationCount: 0,
      successfulTasks: 0,
      lastInteraction: tenDaysAgo,
    });
    const s = await stage();
    expect(s).toContain("Getting comfortable"); // still the familiar branch
    expect(s).toContain("10 days");             // the real, tracked figure stays
    expect(s).not.toMatch(/conversation/i);     // the fabricated count is gone
  });
});
