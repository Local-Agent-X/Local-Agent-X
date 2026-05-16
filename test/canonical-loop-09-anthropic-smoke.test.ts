/**
 * Issue 09 — Anthropic adapter real-CLI smoke tests.
 *
 * These tests make LIVE calls to the Anthropic CLI / API. They are gated
 * behind `LAX_RUN_ANTHROPIC_SMOKE=1` and skipped by default. The standard
 * canonical-loop suite never makes external API calls.
 *
 * Coverage when enabled:
 *   - End-to-end submit through canonical-loop with the live transport,
 *     simple prompt, op reaches `succeeded`.
 *   - Real cancel mid-stream actually aborts the Claude CLI subprocess
 *     (the existing stream-cli.ts honors `signal` and kills `claude`).
 *   - Provider_state envelope size cap doesn't trip on a typical turn.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AnthropicAdapter,
  canonicalLoopEntry,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
  setLeaseConfig,
  resetLeaseConfig,
  opCancel,
  readCanonicalEvents,
  readOpTurn,
  subscribeOpStream,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

const SMOKE_ENABLED = process.env.LAX_RUN_ANTHROPIC_SMOKE === "1";
const describeSmoke = SMOKE_ENABLED ? describe : describe.skip;

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000 });
});

afterEach(async () => {
  await awaitIdle(15_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

function mkOp(label: string, lane: Op["lane"] = "interactive"): Op {
  return {
    id: track(newOpId(`it09s_${label}`)),
    type: "freeform",
    task: `issue-09 smoke ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-09-smoke",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitState(opId: string, target: "succeeded" | "failed" | "cancelled", timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    if (op?.canonical?.state === target) return;
    if (Date.now() > deadline) {
      throw new Error(`awaitState(${target}) timed out for ${opId} — state=${op?.canonical?.state}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

describeSmoke("Issue 09 — Anthropic adapter real-CLI smoke (LAX_RUN_ANTHROPIC_SMOKE=1)", () => {
  it("end-to-end: simple prompt reaches `succeeded`", async () => {
    const op = mkOp("e2e-happy");
    op.task = "Reply with the single word: pong";
    const adapter = new AnthropicAdapter({
      systemPrompt: "Reply concisely.",
    });
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitState(op.id, "succeeded", 60_000);

    expect(readOpTurn(op.id, 0)?.providerState.adapterName).toBe("anthropic");
    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "turn_committed")).toBe(true);
    expect(events.some(e => e.type === "message_appended")).toBe(true);
  }, 90_000);

  it("real cancel mid-stream: opCancel terminates the live stream within ~2s", async () => {
    const op = mkOp("real-cancel");
    op.task = "Write a long detailed essay (~2000 words) about clouds.";
    const adapter = new AnthropicAdapter({});
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>((resolve) => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });

    canonicalLoopEntry(op);
    await firstChunk;

    const t0 = Date.now();
    expect(opCancel(op.id, "smoke-tester").ok).toBe(true);
    await awaitState(op.id, "cancelled", 5_000);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(5_000);

    // Partial turn discarded.
    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "turn_committed")).toBe(false);
    expect(readOpTurn(op.id, 0)).toBeNull();
  }, 30_000);

  it("provider_state envelope stays under the 256 KB cap on a normal turn", async () => {
    const op = mkOp("size-ok");
    op.task = "Reply with: ok.";
    const adapter = new AnthropicAdapter({});
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitState(op.id, "succeeded", 60_000);

    const turn = readOpTurn(op.id, 0);
    expect(turn).toBeTruthy();
    const size = Buffer.byteLength(JSON.stringify(turn!.providerState), "utf-8");
    expect(size).toBeLessThan(256 * 1024);
  }, 90_000);
});
