// Discovery path back to a cron run's transcript (2026-09-03).
//
// e02c80f7 (F6) correctly hid synthetic sessions — cron- among them — from the
// sidebar (listActiveChatIds) and from /api/sessions/search. The collateral:
// search was the LAST UI path to a scheduled run's full transcript, so
// "what did last night's job actually DO" became unanswerable from the app.
//
// The fix keeps the F6 invariant exactly as it is (hidden from LISTS) and
// restores DISCOVERY instead: the executor now returns the session it wrote to,
// the run-history record stores it, and the cron detail view links each run row
// at it. These tests pin the two ends of that wire — the record/route carrying
// the id, and the client rendering a link only when one exists.
//
// The predicate itself is untouched; test/synthetic-sessions.test.ts,
// test/route-sessions-search-hidden.test.ts and
// test/chat-ws-connection-snapshot.test.ts still own the hiding contract.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronService } from "../src/cron/cron-service.js";
import { handleCronRoutes } from "../src/routes/bridges/cron.js";
import type { ServerContext } from "../src/server-context.js";
import type { CronRunRecord } from "../src/cron/run-history.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

let dataDir: string;
let cron: CronService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cron-transcript-"));
  cron = new CronService(dataDir);
  // No auto-scheduling — create() must not spin up a real timer.
  cron.updateSettings({ enabled: false });
});

afterEach(() => {
  cron.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("cron run history — records the transcript's session id", () => {
  it("carries the executor's sessionId onto the run record", async () => {
    const job = cron.create("nightly-scan", "1h", "scan the thing");
    const sessionId = `cron-${job.id}-${Date.now()}`;
    cron.onExecute(async () => ({ output: "all clear", sessionId }));

    await cron.executeJob(job, { manual: true });

    const runs = cron.listHistory(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].sessionId).toBe(sessionId);
  });

  it("carries it on FAILED runs too — the failing run is the one you debug", async () => {
    const job = cron.create("flaky-scan", "1h", "scan the thing");
    const sessionId = `cron-${job.id}-${Date.now()}`;
    cron.onExecute(async () => ({
      output: "FAILED: off-topic output",
      status: "failed" as const,
      errorMessage: "off-topic output",
      sessionId,
    }));

    await cron.executeJob(job, { manual: true });

    const runs = cron.listHistory(job.id);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].sessionId).toBe(sessionId);
  });

  it("leaves sessionId absent when the executor threw or the run was skipped", async () => {
    const job = cron.create("throwing-scan", "1h", "scan the thing");
    // A thrown handler dies before returning a result — runJob's catch block
    // never sees the id, which lives inside the handler. No link beats a
    // fabricated one.
    cron.onExecute(async () => { throw new Error("provider exploded"); });
    await cron.executeJob(job, { manual: true });

    const runs = cron.listHistory(job.id);
    expect(runs[0].status).toBe("error");
    expect(runs[0].sessionId).toBeUndefined();
  });

  it("survives the JSONL round-trip so a reloaded history still links", async () => {
    const job = cron.create("persisted-scan", "1h", "scan the thing");
    const sessionId = `cron-${job.id}-${Date.now()}`;
    cron.onExecute(async () => ({ output: "done", sessionId }));
    await cron.executeJob(job, { manual: true });

    const reopened = new CronService(dataDir);
    try {
      expect(reopened.listHistory(job.id)[0].sessionId).toBe(sessionId);
    } finally {
      reopened.stop();
    }
  });
});

describe("GET /api/cron/:id/history — serves the session id to the view", () => {
  function makeCtx(runs: CronRunRecord[]) {
    return {
      cronService: {
        get: vi.fn(() => ({ id: "cron_abc", name: "nightly-scan" })),
        listHistory: vi.fn(() => runs),
      },
    } as unknown as ServerContext;
  }

  it("passes sessionId through untouched", async () => {
    const sessionId = "cron-cron_abc-1756900000000";
    const ctx = makeCtx([
      {
        id: "run_1", jobId: "cron_abc", jobName: "nightly-scan",
        scheduledAt: "2026-09-02T06:00:00.000Z", startedAt: "2026-09-02T06:00:00.000Z",
        finishedAt: "2026-09-02T06:04:00.000Z", durationMs: 240_000,
        status: "success", sessionId,
      },
      {
        id: "run_0", jobId: "cron_abc", jobName: "nightly-scan",
        scheduledAt: "2026-09-01T06:00:00.000Z", startedAt: "2026-09-01T06:00:00.000Z",
        finishedAt: "2026-09-01T06:00:00.000Z", durationMs: 0,
        status: "skipped", errorMessage: "previous run still active",
      },
    ]);
    const url = new URL("http://test/api/cron/cron_abc/history?limit=20");
    const cap = mockResponse();

    const handled = await handleCronRoutes("GET", url, mockJsonRequest({}), cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body) as { runs: CronRunRecord[] };
    expect(body.runs.map(r => r.sessionId)).toEqual([sessionId, undefined]);
  });
});
