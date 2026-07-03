import { describe, it, expect } from "vitest";
import { enqueueCompletion } from "../src/agency/completion-queue.js";
import {
  drainPendingNotifications,
  findRecentCompletionMatching,
  findAnyRecentCompletion,
  markSurfacedViaNudge,
  formatNotificationsForSystemPrompt,
  pushPendingNotification,
} from "../src/ops/pending-notifications.js";

// OP-1 regression: a sub-agent completion must reach the parent through the
// canonical pending-notifications channel. Pre-fix, enqueueCompletion wrote
// into a private Map that no live path drained (the legacy-loop consumer was
// deleted), so the parent learned nothing and the Map grew unbounded.
//
// The bridge is tagged subAgent so it does NOT leak into the coupled systems
// that share the channel (the skeptic's refutation of the first attempt):
//   - completionHistory → op_submit_async dedup/casual guards
//   - markSurfacedViaNudge → user-facing idle nudge
//   - "Original task" labeling in the system-prompt block

// Module state is a singleton; isolate by unique sessionIds per test.
let counter = 0;
const sid = () => `parent-sess-${Date.now()}-${++counter}`;

describe("completion-queue → pending-notifications bridge", () => {
  it("surfaces a sub-agent completion on the parent's canonical drain", () => {
    const parent = sid();

    enqueueCompletion(parent, {
      agentId: "field-agent-7",
      agentName: "researcher",
      status: "succeeded",
      result: "found the answer: 42",
      timestamp: Date.now(),
    });

    const drained = drainPendingNotifications(parent);
    expect(drained).toHaveLength(1);
    const n = drained[0];
    expect(n.status).toBe("completed"); // "succeeded" → canonical "completed"
    expect(n.summary).toBe("found the answer: 42");
    expect(n.task).toBe("researcher");
    expect(n.opId).toBe("agent-field-agent-7");
    expect(n.subAgent).toBe(true);

    // Drained once → cleared, so the parent doesn't re-narrate it next turn.
    expect(drainPendingNotifications(parent)).toHaveLength(0);
  });

  it("maps failed status and ignores empty parent sessions", () => {
    const parent = sid();

    // No parent session → no-op, must not throw.
    expect(() => enqueueCompletion("", {
      agentId: "x", agentName: "x", status: "failed", result: "boom", timestamp: Date.now(),
    })).not.toThrow();

    enqueueCompletion(parent, {
      agentId: "field-agent-9",
      agentName: "builder",
      status: "failed",
      result: "the build errored",
      timestamp: Date.now(),
    });

    const drained = drainPendingNotifications(parent);
    expect(drained).toHaveLength(1);
    expect(drained[0].status).toBe("failed");
  });

  it("does NOT pollute the re-delegation dedup guards (agent name ≠ user task)", () => {
    const parent = sid();

    enqueueCompletion(parent, {
      agentId: "field-agent-7",
      agentName: "researcher",
      status: "succeeded",
      result: "found the answer: 42",
      timestamp: Date.now(),
    });

    // Skeptic's break case: a genuinely new task containing the agent-name
    // slug must NOT be blocked as "near-identical already completed".
    expect(findRecentCompletionMatching(parent, "update the researcher onboarding doc")).toBeNull();
    // And the casual-reply guard must not see the internal completion either
    // (pre-refutation-fix this returned the sub-agent entry, blocking ALL
    // new op spawns after any casual reply).
    expect(findAnyRecentCompletion(parent)).toBeNull();
  });

  it("is invisible to the idle nudge but still drains for the agent afterwards", () => {
    const parent = sid();

    enqueueCompletion(parent, {
      agentId: "field-agent-7",
      agentName: "researcher",
      status: "succeeded",
      result: "found the answer: 42",
      timestamp: Date.now(),
    });

    // A nudge fire must not announce internal sub-agent completions to the
    // user ("that op just finished, want a walkthrough?").
    expect(markSurfacedViaNudge(parent)).toHaveLength(0);
    // ...but the completion still reaches the agent on its next real turn.
    const drained = drainPendingNotifications(parent);
    expect(drained).toHaveLength(1);
    expect(drained[0].surfacedViaNudge).toBeFalsy();
  });

  it("renders as a Sub-agent line, never as 'Original task', and points at agent_output", () => {
    const parent = sid();

    enqueueCompletion(parent, {
      agentId: "field-agent-7",
      agentName: "researcher",
      status: "succeeded",
      result: "x".repeat(500), // over the preview budget → truncation pointer
      timestamp: Date.now(),
    });

    const block = formatNotificationsForSystemPrompt(drainPendingNotifications(parent));
    expect(block).toContain("✓ Sub-agent `researcher` completed");
    expect(block).not.toContain("Original task");
    // Full result lives in agent output, not behind a (nonexistent) op.
    expect(block).toContain('agent_output(agent_id="field-agent-7")');
    expect(block).not.toContain("op_status");
  });

  it("does not regress the real-op dedup guard sharing the same session", () => {
    const parent = sid();

    // A sub-agent completes AND a real user-submitted op completes.
    enqueueCompletion(parent, {
      agentId: "field-agent-7",
      agentName: "researcher",
      status: "succeeded",
      result: "found it",
      timestamp: Date.now(),
    });
    // Real op path (session-bridge-observer) — no subAgent tag.
    pushPendingNotification(parent, {
      opId: "op-real-1",
      status: "completed",
      summary: "done",
      filesChanged: [],
      task: "build the homepage hero section",
      completedAt: Date.now(),
    });

    // The real op still guards against re-delegation...
    expect(findRecentCompletionMatching(parent, "build the homepage hero")?.opId).toBe("op-real-1");
    // ...while the sub-agent entry stays out of the history entirely.
    expect(findRecentCompletionMatching(parent, "ask the researcher agent again")).toBeNull();
  });
});
