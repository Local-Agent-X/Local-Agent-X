/**
 * trash-scope-observer — task-end closing of the task-trash scope.
 *
 * The invariant under test: only a WORKER-FAMILY session's scope may
 * auto-close (isWorkerScopedSession — the `agent-*` runtime family plus the
 * headless synthetic runs). A user-surface session (chat, ide-, cron-,
 * bridges, voice) NEVER has its scope auto-closed, whatever op traffic it
 * carries — op_submit_async tracks delegated ops under the ORIGINATING chat
 * session (delegatedRuntimeSessionId = originating || opId), so an op-type
 * discriminator alone would let a background op completing BETWEEN turns
 * close the chat's scope (skeptic Q2d) and downgrade chat trash from the
 * 30-day retention to the 24h closed-TTL. Plus the wiring:
 * projectCanonicalEvent fires the observer BEFORE the session-bridge
 * observer releases the op↔session binding.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "./types.js";

// ops/op-store.ts binds OPS_BASE = join(getLaxDir(), …) at import, so isolate
// the data dir BEFORE the dynamic imports below (full-turn.test.ts pattern) —
// nothing touches ~/.lax.
const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = mkdtempSync(join(tmpdir(), "lax-trash-scope-obs-"));
process.env.LAX_DATA_DIR = laxDir;
const workDir = mkdtempSync(join(tmpdir(), "lax-trash-scope-work-"));
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  for (const d of [laxDir, workDir]) rmSync(d, { recursive: true, force: true });
});

const { recordTrashScopeEvent, isWorkerScopedSession } = await import("./trash-scope-observer.js");
const { projectCanonicalEvent } = await import("./event-emitter.js");
const { writeOp } = await import("../ops/op-store.js");
const { trackOpForSession, listOpsForSession, releaseOpFromSession } = await import("../ops/session-bridge.js");
const { moveToTaskTrash } = await import("../safe-delete.js");
const { cancelIdleNudge } = await import("../ops/idle-nudge.js");

let seq = 0;
const trackedOps: string[] = [];

function makeTrackedOp(type: string, sessionId: string): string {
  const id = `op_trash_scope_${type}_${seq++}`;
  writeOp({ id, type, status: "running" } as never);
  trackOpForSession(id, sessionId, "trash-scope test op");
  trackedOps.push(id);
  return id;
}

/** Create the session's task-trash scope by actually trashing a file. */
function openScope(sessionId: string): string {
  const f = join(workDir, `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}-artifact-${seq++}.txt`);
  writeFileSync(f, "trashed bytes", "utf-8");
  expect(moveToTaskTrash(sessionId, f)).toBeTruthy();
  return join(laxDir, "trash", "task", sessionId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function stateChanged(opId: string, to: string): CanonicalEvent {
  return { type: "state_changed", opId, body: { from: "running", to } } as unknown as CanonicalEvent;
}

const closedMarker = (scope: string) => join(scope, ".closed");

afterEach(() => {
  for (const id of trackedOps) releaseOpFromSession(id);
  trackedOps.length = 0;
});

describe("isWorkerScopedSession — the discriminator, pinned against the minting families", () => {
  it("covers the agent-* runtime family and the headless synthetic runs", () => {
    // handler-events.ts:90 mints `agent-<runId>` (runSessionId = req.sessionId
    // ?? `agent-${agentId}`); agency/handler-types.ts documents the borrowed
    // `agent-op-<opId>` for operations-executor phases; escalate-tool.ts
    // validates the family via Handler.getAgentStatus(sessionId.slice(6)).
    expect(isWorkerScopedSession("agent-run123")).toBe(true);
    expect(isWorkerScopedSession("agent-op-op_abc123")).toBe(true);
    // chat-ws/broadcast.ts HEADLESS_SESSION_PREFIXES = eval_/skill-review-/dream-
    expect(isWorkerScopedSession("skill-review-1725-1")).toBe(true);
    expect(isWorkerScopedSession("dream-2026-09-02")).toBe(true);
    expect(isWorkerScopedSession("eval_abc")).toBe(true);
  });

  it("excludes every user surface — chat, ide-, cron-, bridges, voice", () => {
    for (const id of ["sess-chat-1", "ide-workspace-2", "cron-job-3", "tg-99887", "wa-99887", "voice-main", "default"]) {
      expect(isWorkerScopedSession(id), id).toBe(false);
    }
  });
});

describe("trash-scope-observer — a worker session's last op closes its scope (positive control)", () => {
  it.each(["succeeded", "failed", "cancelled"] as const)("closes the worker scope when its only op terminates (%s)", (to) => {
    const sessionId = `agent-op-trash-close-${to}`;
    const scope = openScope(sessionId);
    const opId = makeTrackedOp("freeform", sessionId);

    recordTrashScopeEvent(stateChanged(opId, to));

    expect(existsSync(closedMarker(scope))).toBe(true);
  });

  it("a headless synthetic session (skill-review-) closes too", () => {
    const sessionId = "skill-review-trash-close";
    const scope = openScope(sessionId);
    const opId = makeTrackedOp("skill_review", sessionId);

    recordTrashScopeEvent(stateChanged(opId, "succeeded"));

    expect(existsSync(closedMarker(scope))).toBe(true);
  });

  it("a non-terminal transition never closes", () => {
    const sessionId = "agent-trash-running";
    const scope = openScope(sessionId);
    const opId = makeTrackedOp("freeform", sessionId);

    recordTrashScopeEvent(stateChanged(opId, "running"));

    expect(existsSync(closedMarker(scope))).toBe(false);
  });

  it("a live peer op defers the close; the LAST op out closes", () => {
    const sessionId = "agent-op-trash-peers";
    const scope = openScope(sessionId);
    const first = makeTrackedOp("freeform", sessionId);
    const second = makeTrackedOp("delegated", sessionId);

    recordTrashScopeEvent(stateChanged(first, "succeeded"));
    expect(existsSync(closedMarker(scope))).toBe(false); // `second` is still live — deferred

    // In production the bridge observer releases each terminal op right after
    // this observer runs; mirror that between the two terminals.
    releaseOpFromSession(first);
    recordTrashScopeEvent(stateChanged(second, "succeeded"));
    expect(existsSync(closedMarker(scope))).toBe(true);
  });
});

describe("trash-scope-observer — user-surface scopes are NEVER auto-closed (skeptic Q2d)", () => {
  it("REGRESSION Q2d: a delegated op completing BETWEEN chat turns leaves the chat scope open", () => {
    // op_submit_async tracks the op under the ORIGINATING chat session
    // (ops/tools/shared.ts delegatedRuntimeSessionId → originatingSessionId),
    // and chat-turn delete_file trashed into that same scope. Between turns
    // there is no live chat_turn peer — pre-fix this closed the CHAT scope
    // and silently downgraded chat trash to the 24h closed-TTL.
    const chatSession = "sess-chat-q2d";
    const scope = openScope(chatSession); // chat-turn delete_file's trash
    const bgOp = makeTrackedOp("delegated", chatSession); // op_submit_async tracking
    // No chat_turn op is live: the user is between turns.
    expect(listOpsForSession(chatSession)).toEqual([bgOp]);

    recordTrashScopeEvent(stateChanged(bgOp, "succeeded"));

    expect(existsSync(closedMarker(scope))).toBe(false); // 30-day window intact
  });

  it.each(["ide-editor-q2d", "cron-nightly-q2d", "tg-12345"] as const)("other user surfaces (%s) stay open too", (sessionId) => {
    const scope = openScope(sessionId);
    const opId = makeTrackedOp("freeform", sessionId);

    recordTrashScopeEvent(stateChanged(opId, "failed"));

    expect(existsSync(closedMarker(scope))).toBe(false);
  });

  it.each(["chat_turn", "voice_turn"] as const)("belt: an interactive host turn (%s) never closes even under a worker-family session id", (type) => {
    const sessionId = `agent-trash-${type}`;
    const scope = openScope(sessionId);
    const opId = makeTrackedOp(type, sessionId);

    recordTrashScopeEvent(stateChanged(opId, "succeeded"));

    expect(existsSync(closedMarker(scope))).toBe(false);
  });
});

describe("trash-scope-observer — posture", () => {
  it("never throws: unreadable op, untracked session, and a scope-less session are all no-ops", () => {
    expect(() => recordTrashScopeEvent(stateChanged("op_never_written", "succeeded"))).not.toThrow();

    const orphan = makeTrackedOp("freeform", "agent-trash-no-scope"); // session never trashed anything
    expect(() => recordTrashScopeEvent(stateChanged(orphan, "failed"))).not.toThrow();
    expect(existsSync(join(laxDir, "trash", "task", "agent-trash-no-scope"))).toBe(false);
  });

  it("honours the relay path's explicit session override — worker closes, chat never", () => {
    const workerSession = "agent-op-trash-override";
    const workerScope = openScope(workerSession);
    const chatSession = "sess-chat-override";
    const chatScope = openScope(chatSession);
    const w = `op_trash_scope_relay_${seq++}`;
    const c = `op_trash_scope_relay_${seq++}`;
    writeOp({ id: w, type: "freeform", status: "running" } as never); // deliberately NOT tracked (relay posture)
    writeOp({ id: c, type: "freeform", status: "running" } as never);

    recordTrashScopeEvent(stateChanged(w, "succeeded"), workerSession);
    recordTrashScopeEvent(stateChanged(c, "succeeded"), chatSession);

    expect(existsSync(closedMarker(workerScope))).toBe(true);
    expect(existsSync(closedMarker(chatScope))).toBe(false);
  });
});

describe("trash-scope-observer — wiring at the projectCanonicalEvent seam", () => {
  it("fires through the real projection, BEFORE the bridge releases the op↔session binding", () => {
    const sessionId = "agent-op-trash-wire";
    const scope = openScope(sessionId);
    const opId = makeTrackedOp("freeform", sessionId);
    try {
      // "failed" is terminal for both observers but skips the bridge's
      // completed-only artifact-url scan — the leanest real projection.
      projectCanonicalEvent(stateChanged(opId, "failed"));

      // The close fired even though the bridge observer released the op in the
      // SAME projection — proof the wiring line runs before bridgeRecord
      // (after the release, getSessionForOp finds nothing and the close could
      // never happen).
      expect(existsSync(closedMarker(scope))).toBe(true);
      expect(listOpsForSession(sessionId)).toEqual([]);
    } finally {
      cancelIdleNudge(sessionId); // the bridge's terminal branch scheduled one
    }
  });
});
