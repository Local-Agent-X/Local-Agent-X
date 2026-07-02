/**
 * Regression: the delegation RETURN path — rich context goes out to a worker,
 * but the worker's result must also come BACK to the delegating parent.
 *
 * Two coupled halves, both previously broken:
 *
 *   OP-2  context-pack-builder packs `context.recentTurns`, but
 *         buildInitialUserContent rendered every other contextPack field and
 *         OMITTED recentTurns — so a worker saw only the terse task string,
 *         never the conversation that produced it.
 *
 *   OP-3  three sites handed the parent a content-free status: the completion
 *         notification summary was the literal "task completed", op_wait
 *         returned "op <id> completed", and op_status returned only a
 *         tool-name-per-turn list — none surfaced the worker's FINAL assistant
 *         message (the actual answer).
 *
 * These tests drive the real seams: OP-2 through the pack builder → renderer,
 * OP-3 through the three tool/observer OUTPUTS (op_wait, op_status, and the
 * pending-notification the session-bridge observer pushes). All assertions
 * fail on the old code (recentTurns omitted / "task completed" et al. carry no
 * result) and pass on the fix.
 */

import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { getLaxDir } from "../src/lax-data-dir.js";
import { buildContextPack } from "../src/ops/context-pack-builder.js";
import { buildInitialUserContent } from "../src/canonical-loop/initial-prompt.js";
import { writeOp } from "../src/ops/op-store.js";
import { appendOpMessage } from "../src/canonical-loop/store.js";
import { recordCanonicalEvent } from "../src/canonical-loop/session-bridge-observer.js";
import { trackOpForSession } from "../src/ops/session-bridge.js";
import { drainPendingNotifications } from "../src/ops/pending-notifications.js";
import { opWaitTool } from "../src/ops/tools/op-wait.js";
import { opStatusTool } from "../src/ops/tools/op-status.js";
import type { Op, ContextPack } from "../src/ops/types.js";
import type { CanonicalEvent, CanonicalMessageRole } from "../src/canonical-loop/types.js";

const created: string[] = [];

afterEach(() => {
  for (const id of created) {
    try { rmSync(join(getLaxDir(), "operations", id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  created.length = 0;
});

function makeOp(id: string, over: Partial<Op> = {}, recentTurns: ChatCompletionMessageParam[] = []): Op {
  const pack: ContextPack = {
    task: { description: "Fix the fee calc", successCriteria: [], constraints: [], notWhatToRedo: [] },
    context: { recentTurns, referencedFiles: [], memoryHits: [], agentsRules: "" },
    capabilities: {},
    budget: { maxIterations: 30, maxTokens: 80_000, maxWallTimeMs: 900_000, maxSelfEditCalls: 5 },
    routing: { lane: "build" },
    secrets: { allowed: [] },
  };
  return {
    id,
    type: "freeform",
    task: "Fix the fee calc",
    contextPack: pack,
    lane: "build",
    retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    ...over,
  };
}

/** Persist a terminal op + its op_messages on disk (the real writers). */
function seedTerminalOp(
  id: string,
  messages: { role: CanonicalMessageRole; content: unknown }[],
): void {
  created.push(id);
  writeOp(makeOp(id, {
    status: "completed",
    completedAt: new Date().toISOString(),
    canonical: { state: "succeeded" },
  }));
  messages.forEach((m, i) => {
    appendOpMessage({
      messageId: `${id}-m${i}`,
      opId: id,
      turnIdx: i,
      seqInTurn: 0,
      role: m.role,
      content: m.content,
      createdAt: new Date().toISOString(),
    });
  });
}

describe("delegation return path — OP-2: recentTurns reach the worker prompt", () => {
  it("renders the parent session's recent conversation into the initial user content", async () => {
    // Real seam: parentSessionMessages → context-pack-builder.sliceRecentTurns
    // → contextPack.context.recentTurns → buildInitialUserContent.
    const pack = await buildContextPack({
      description: "Fix the kraken fee calc",
      parentSessionMessages: [
        { role: "user", content: "the kraken bot fee calc is double-counting maker fees" },
        { role: "assistant", content: "got it — which module owns the fee math?" },
      ],
    });

    // The builder DOES populate recentTurns (the audited premise).
    expect(pack.context.recentTurns.length).toBe(2);

    const { text } = buildInitialUserContent(makeOp("op_op2_render", { contextPack: pack }));

    // Old code omitted recentTurns entirely — these two assertions fail on it.
    expect(text).toContain("Recent conversation");
    expect(text).toContain("double-counting maker fees");
    expect(text).toContain("which module owns the fee math");
  });

  it("caps the block to the last 6 turns and truncates long entries", async () => {
    const turns: ChatCompletionMessageParam[] = [];
    for (let i = 0; i < 10; i++) turns.push({ role: "user", content: `turn-marker-${i}` });
    const longLine = "X".repeat(1200);
    turns.push({ role: "assistant", content: longLine });

    const pack = await buildContextPack({ description: "t", parentSessionMessages: turns, parentTurnsToInclude: 12 });
    const { text } = buildInitialUserContent(makeOp("op_op2_cap", { contextPack: pack }));

    // Oldest turns are dropped (rendered block keeps only the last ~6).
    expect(text).not.toContain("turn-marker-0");
    expect(text).toContain("turn-marker-9");
    // The 1200-char turn is truncated well below its original length.
    const rendered = text.slice(text.indexOf("Recent conversation"));
    expect(rendered).not.toContain(longLine);
    expect(rendered).toContain("…");
  });
});

describe("delegation return path — OP-3: the worker's result reaches the parent", () => {
  const FINDINGS = "FINDINGS: the root cause is a double-counted maker fee in fees.ts";

  it("op_wait surfaces the final assistant message, not a bare 'op <id> completed'", async () => {
    const id = "op_op3_wait_1";
    seedTerminalOp(id, [
      { role: "user", content: { text: "audit the fee calc" } },
      { role: "assistant", content: { text: FINDINGS } },
    ]);

    const res = await opWaitTool.execute({ op_id: id });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(FINDINGS);          // fails on old code
  });

  it("op_status surfaces the final assistant message at terminal state", async () => {
    const id = "op_op3_status_1";
    seedTerminalOp(id, [
      { role: "user", content: { text: "audit the fee calc" } },
      { role: "assistant", content: { text: FINDINGS } },
    ]);

    const res = await opStatusTool.execute({ op_id: id, _sessionId: "" });
    expect(res.content).toContain("final result");
    expect(res.content).toContain(FINDINGS);          // fails on old code (turn-list only)
  });

  it("the completion notification carries the final message instead of 'task completed'", () => {
    const id = "op_op3_notify_1";
    const sessionId = "sess-op3-notify";
    seedTerminalOp(id, [
      { role: "user", content: { text: "audit the fee calc" } },
      { role: "assistant", content: { text: FINDINGS } },
    ]);
    trackOpForSession(id, sessionId, "audit the fee calc");

    const evt = { type: "state_changed", opId: id, body: { from: "running", to: "succeeded" } } as unknown as CanonicalEvent;
    recordCanonicalEvent(evt);

    const [note] = drainPendingNotifications(sessionId);
    expect(note).toBeDefined();
    expect(note.status).toBe("completed");
    expect(note.summary).toContain("FINDINGS");       // fails on old code ("task completed")
    expect(note.summary).not.toBe("task completed");
  });

  it("skips a pure tool-call final turn and reports the last assistant text", async () => {
    const id = "op_op3_skip_toolcall";
    seedTerminalOp(id, [
      { role: "user", content: { text: "audit the fee calc" } },
      { role: "assistant", content: { text: FINDINGS } },
      // Terminal turn was a tool call with no assistant text — extraction must
      // walk past it to the last texted assistant turn.
      { role: "assistant", content: { toolCalls: [{ id: "t1", name: "read", args: "{}" }] } },
    ]);

    const res = await opStatusTool.execute({ op_id: id, _sessionId: "" });
    expect(res.content).toContain(FINDINGS);
  });
});
