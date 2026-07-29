/**
 * memory-backfill scheduling gate.
 *
 * Live bug behind this file: the boot backfill walked the whole corpus on the
 * main event loop (measured: 3.6 GB across ~750k reads at ~0% CPU). The loop
 * went silent for minutes, the UI never became usable, and the app had to be
 * force-quit. That freeze is fixed where it happens — the walk now yields
 * between files (memory/universal-index-backfill.ts, pinned by its own test).
 *
 * This file pins the SCHEDULING half: when a scan is allowed to start. Both
 * gates are contention gates. The one thing deliberately NOT a gate is
 * embedding-provider availability — an earlier revision skipped the walk on
 * probeEmbeddingsDegraded(), which both misdiagnosed the freeze and trusted a
 * probe that reported Ollama down while Ollama was up and serving. Skipping
 * indexing on a bad signal loses content; running it without an embedder only
 * costs a walk, because chunks land keyword-searchable and get vectors later
 * from reembedMissingChunks.
 */

import { describe, it, expect } from "vitest";
import {
  decideBackfill,
  attemptBackfill,
  BACKFILL_RETRY_MS,
  BACKFILL_BOOT_SETTLE_MS,
} from "./index.js";

/** The scan is armed this long after the server starts (startBackgroundJobs). */
const FIRST_ARM_MS = 15_000;

describe("decideBackfill", () => {
  it("runs when nothing is in the foreground and the server has settled", () => {
    expect(decideBackfill({ foregroundBusy: false, serverStarting: false })).toEqual({ run: true });
  });

  it("defers to a live turn", () => {
    const d = decideBackfill({ foregroundBusy: true, serverStarting: false });
    expect(d.run).toBe(false);
    expect(d).toMatchObject({ reason: "foreground-busy" });
  });

  it("defers while the server is still coming up", () => {
    // Boot is invisible to the foreground check — it infers activity from
    // session updatedAt, and at boot no session has been written yet.
    const d = decideBackfill({ foregroundBusy: false, serverStarting: true });
    expect(d.run).toBe(false);
    expect(d).toMatchObject({ reason: "server-starting" });
  });

  it("re-checks on a bounded delay rather than dropping the scan", () => {
    for (const input of [
      { foregroundBusy: true, serverStarting: false },
      { foregroundBusy: false, serverStarting: true },
    ]) {
      const d = decideBackfill(input);
      if (d.run) throw new Error("expected a deferral");
      expect(d.retryMs).toBe(BACKFILL_RETRY_MS[d.reason]);
      expect(d.retryMs).toBeGreaterThan(0);
    }
  });

  it("has no embedder-availability skip reason at all", () => {
    // Regression pin on the retracted theory: there must be no way to express
    // "the embedder is down, so don't index".
    expect(Object.keys(BACKFILL_RETRY_MS)).toEqual(["foreground-busy", "server-starting"]);
  });
});

describe("attemptBackfill", () => {
  const harness = (over: Partial<Parameters<typeof attemptBackfill>[0]> = {}) => {
    const calls = { scans: 0, retries: [] as number[] };
    const deps = {
      foregroundBusy: () => false,
      serverStarting: () => false,
      scan: async () => { calls.scans++; },
      retry: (ms: number) => { calls.retries.push(ms); },
      ...over,
    };
    return { calls, deps };
  };

  it("scans when both gates are clear", async () => {
    const { calls, deps } = harness();
    expect(await attemptBackfill(deps)).toEqual({ run: true });
    expect(calls.scans).toBe(1);
    expect(calls.retries).toEqual([]);
  });

  it("never consults an embedder probe, and indexes even when one says down", async () => {
    // The probe is supplied and deliberately reports the worst case. Indexing
    // must proceed anyway: it is idempotent, and un-embedded chunks are still
    // keyword-searchable and re-embed later. A revision that re-introduces the
    // gate has to call this hook, and fails here.
    const probe = { calls: 0 };
    const { calls, deps } = harness();
    const withProbe = {
      ...deps,
      embeddingsDegraded: async () => { probe.calls++; return true; },
    };
    const d = await attemptBackfill(withProbe);
    expect(d).toEqual({ run: true });
    expect(probe.calls).toBe(0);
    expect(calls.scans).toBe(1);
  });

  it("re-arms instead of scanning during a live turn", async () => {
    const { calls, deps } = harness({ foregroundBusy: () => true });
    await attemptBackfill(deps);
    expect(calls.scans).toBe(0);
    expect(calls.retries).toEqual([BACKFILL_RETRY_MS["foreground-busy"]]);
  });

  it("re-arms instead of scanning while the server is starting", async () => {
    const { calls, deps } = harness({ serverStarting: () => true });
    await attemptBackfill(deps);
    expect(calls.scans).toBe(0);
    expect(calls.retries).toEqual([BACKFILL_RETRY_MS["server-starting"]]);
  });

  it("the boot deferral always clears — one re-check and it runs", async () => {
    // Simulated clock, not wall-clock: the assertion is that the re-check
    // carries the decision past the settle window, so the gate is bounded and
    // can never become an indefinite skip.
    let now = FIRST_ARM_MS; // the first arm fires this long after start
    let scans = 0;
    let attempts = 0;

    while (attempts < 10 && scans === 0) {
      attempts++;
      let retryAt: number | null = null;
      await attemptBackfill({
        foregroundBusy: () => false,
        serverStarting: () => now < BACKFILL_BOOT_SETTLE_MS,
        scan: async () => { scans++; },
        retry: (ms) => { retryAt = now + ms; },
      });
      if (scans === 0) {
        expect(retryAt).not.toBeNull();
        now = retryAt as unknown as number;
      }
    }

    expect(scans).toBe(1);
    expect(attempts).toBe(2); // defers once at 15s, runs on the 30s re-check
  });
});
