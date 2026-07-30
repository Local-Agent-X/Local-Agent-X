import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  SESSION_EVENT_TYPES,
  validateRelayPayload,
  type ProcessRelayRecord,
  buildBrowserDelivery,
  type ProcessRelayGenerationState,
} from "../canonical-loop/public/process-relay.js";
import { GLOBAL_EVENT_TYPES } from "../chat-ws/process-relay-delivery.js";
import { wireBridgeBroadcasters } from "../chat-ws/bridge-wiring.js";
import { clients } from "../chat-ws/state.js";
import { broadcastToSession as driveSessionBroadcaster } from "../ops/session-bridge.js";
import type { ServerEvent } from "./server-events.js";

// Compile-time census of every discriminator in the ServerEvent union. The key
// type is ServerEvent["type"], so adding a variant to the union without listing
// it here is a tsc error (npm run build) — and the drift guard below then
// proves the relay's hand-maintained SESSION_EVENT_TYPES learned the same name.
// This record is the ONLY place the union's members are enumerated in tests.
const ALL_SERVER_EVENT_TYPES: Record<ServerEvent["type"], true> = {
  stream: true,
  reasoning: true,
  tool_start: true,
  tool_progress: true,
  tool_end: true,
  tool_chip: true,
  usage: true,
  done: true,
  stopped: true,
  error: true,
  secret_request: true,
  secrets_request: true,
  approval_requested: true,
  approval_timeout: true,
  approval_resolved: true,
  context_status: true,
  visual: true,
  bg_op_queued: true,
  bg_op_queue_reordered: true,
  bg_op_started: true,
  bg_op_progress: true,
  bg_op_completed: true,
  bg_op_nudge: true,
  av_blocked_warning: true,
  worker_stream: true,
  worker_done: true,
  chat_op_started: true,
  prepare_progress: true,
  turn_provider: true,
  inject_queued: true,
  inject_consumed: true,
  plan_mode_changed: true,
  op_heartbeat: true,
};

describe("ServerEvent ↔ process relay drift", () => {
  it("lists every ServerEvent variant in SESSION_EVENT_TYPES", () => {
    const missing = Object.keys(ALL_SERVER_EVENT_TYPES)
      .filter((type) => !SESSION_EVENT_TYPES.has(type));
    // SESSION_EVENT_TYPES is the relay's "carriable at all" allowlist, NOT a
    // scope list: validateRelayPayload (process-relay-contract.ts:214) throws
    // "unsupported process relay session event" for any type missing from it,
    // and audience is decided separately and later, by GLOBAL_EVENT_TYPES
    // membership (chat-ws/process-relay-delivery.ts). So "this variant is
    // global-only" is never a reason to omit it here — omitting it just
    // deletes the event at the process boundary, which is the exact bug this
    // guard exists to catch. A new global-scope variant KEEPS its place in
    // SESSION_EVENT_TYPES and is ALSO added to GLOBAL_EVENT_TYPES — that set
    // is the ONLY audience decision, read by both the relay and the
    // in-process bridge broadcaster (chat-ws/bridge-wiring.ts), so there is
    // no third place to update. Nothing belongs on an exclusion list; never
    // weaken this test.
    expect(missing).toEqual([]);
  });

  it("carries no relay name the union no longer defines", () => {
    const stale = [...SESSION_EVENT_TYPES]
      .filter((type) => !(type in ALL_SERVER_EVENT_TYPES));
    expect(stale).toEqual([]);
  });

  it("names only real union variants in GLOBAL_EVENT_TYPES", () => {
    // GLOBAL_EVENT_TYPES is a Set<string>, so tsc cannot catch a typo in it,
    // and a typo fails OPEN and SILENT: `"bg_op_startd"` just never matches a
    // real event, so every fork below classifies that op's events per-session
    // and the AGENTS sidebar goes blind — with no test red anywhere. Making it
    // the one source of truth raised the blast radius of a typo; this raises
    // the guard to match.
    const unknown = [...GLOBAL_EVENT_TYPES]
      .filter((type) => !(type in ALL_SERVER_EVENT_TYPES));
    expect(unknown).toEqual([]);
  });

  it("accepts the new turn_provider and prepare_progress envelopes over the relay", () => {
    const provider: ServerEvent = {
      type: "turn_provider", provider: "anthropic", model: "opus", rerouted: false,
    };
    const prepare: ServerEvent = { type: "prepare_progress", step: "context" };
    expect(() => validateRelayPayload("session-event", provider, "op-1")).not.toThrow();
    expect(() => validateRelayPayload("session-event", prepare, "op-1")).not.toThrow();
  });

  it("still rejects a type that is in neither the union nor the relay set", () => {
    expect(() => validateRelayPayload("session-event", { type: "settings_changed" }, "op-1"))
      .toThrow("unsupported process relay session event");
  });
});

describe("relay audience has a single GLOBAL_EVENT_TYPES", () => {
  const worker: ServerEvent = { type: "worker_done", opId: "op-1", status: "completed" };

  it("classifies scope from the exported set, never a per-module mirror", () => {
    expect(scopeOf({
      type: "bg_op_started", opId: "op-1", task: "t", provider: "anthropic",
    })).toBe("global");
    expect(scopeOf(worker)).toBe("session");

    // Falsifiable identity probe. Teach the ONE exported set a name it does
    // not normally carry and ask the scope classifier — which lives in
    // canonical-loop/process-relay-browser.ts, the other half of the relay —
    // to route on it. A second hand-kept copy of the set over there would
    // still answer "session", and this fails. That is not hypothetical: the
    // two files each declared their own literal until these were collapsed,
    // so nothing but agreement-by-luck kept a bg_op_* event from being
    // classified global on one side and filtered out on the other.
    GLOBAL_EVENT_TYPES.add("worker_done");
    try {
      expect(scopeOf(worker)).toBe("global");
    } finally {
      GLOBAL_EVENT_TYPES.delete("worker_done");
    }
    expect(scopeOf(worker)).toBe("session");
  });
});

describe("both audience forks read one GLOBAL_EVENT_TYPES", () => {
  const bgStarted: ServerEvent = {
    type: "bg_op_started", opId: "op-1", task: "from telegram", provider: "autopilot",
  };
  const workerDone: ServerEvent = { type: "worker_done", opId: "op-1", status: "completed" };

  it("routes the in-process fork on the exported set, never a hand-rolled list", () => {
    // Same producer, two forks. session-bridge-observer mints every bg_op_*;
    // ops/session-bridge.ts:63-74 hands an OUT-of-process op's events to the
    // relay writer (scope decided by GLOBAL_EVENT_TYPES) and an IN-process
    // op's to the bridge-wiring broadcaster. Both must answer the same
    // question the same way or a bg_op_* is global on one path and invisible
    // on the other.
    expect(fanoutOf(bgStarted)).toHaveLength(1);   // global: reaches a non-subscriber
    expect(scopeOf(bgStarted)).toBe("global");
    expect(fanoutOf(workerDone)).toHaveLength(0);  // per-session
    expect(scopeOf(workerDone)).toBe("session");

    // Falsifiable identity probe, aimed at BOTH forks at once. Teach the one
    // exported set a name it does not normally carry; every fork that truly
    // reads it must learn the name in the same breath. A hand-rolled
    // disjunction in bridge-wiring (`event.type === "bg_op_queued" || ...`)
    // keeps answering "per-session" here and this fails — that was the live
    // state of the file this test was written against, and it is exactly how
    // adding a sixth bg_op_* name would have silently un-globaled in-process
    // ops while the whole suite stayed green.
    GLOBAL_EVENT_TYPES.add("worker_done");
    try {
      expect(fanoutOf(workerDone)).toHaveLength(1);
      expect(scopeOf(workerDone)).toBe("global");
    } finally {
      GLOBAL_EVENT_TYPES.delete("worker_done");
    }
    expect(fanoutOf(workerDone)).toHaveLength(0);
    expect(scopeOf(workerDone)).toBe("session");
  });
});

/** Frames a client subscribed to NOTHING receives when the in-process bridge
 *  broadcaster routes `event`. Non-empty means the global (broadcastAll) fork;
 *  empty means the per-session fork, since no client subscribes to `tg-*`. */
function fanoutOf(event: ServerEvent): string[] {
  const sent: string[] = [];
  const ws = { readyState: 1, send: (p: string) => { sent.push(p); } } as unknown as WebSocket;
  clients.set(ws, new Set<string>());
  try {
    wireBridgeBroadcasters();
    driveSessionBroadcaster("tg-12345", event);
  } finally {
    clients.delete(ws);
  }
  return sent;
}

/** Scope the relay assigns a one-event browser delivery. */
function scopeOf(event: ServerEvent): string {
  const state = {
    sealedGeneration: {
      generation: { opId: "op-1", sessionId: "session-1", generationId: "gen-1" },
    },
  } as unknown as ProcessRelayGenerationState;
  const record = {
    kind: "session-event", cursor: 1, deliveryId: "gen-1:1", payload: event,
  } as unknown as ProcessRelayRecord;
  return buildBrowserDelivery(state, record).scope;
}

describe("ServerEvent shapes", () => {
  it("keeps the bare op_heartbeat valid while allowing the turn-shape fields", () => {
    const bare: ServerEvent = { type: "op_heartbeat" };
    const detailed: ServerEvent = {
      type: "op_heartbeat", opId: "op-1", phase: "tool", iteration: 3, activeTool: "bash",
    };
    expect(bare).toEqual({ type: "op_heartbeat" });
    expect(detailed).toEqual({
      type: "op_heartbeat", opId: "op-1", phase: "tool", iteration: 3, activeTool: "bash",
    });
  });

  it("describes one turn's provider, including a reroute", () => {
    const rerouted: ServerEvent = {
      type: "turn_provider",
      provider: "openai",
      model: "gpt-5",
      rerouted: true,
      requestedProvider: "anthropic",
      reason: "rate limited",
    };
    expect(rerouted).toEqual({
      type: "turn_provider",
      provider: "openai",
      model: "gpt-5",
      rerouted: true,
      requestedProvider: "anthropic",
      reason: "rate limited",
    });
    // Never a persisted preference: the event is not, and must not become,
    // a settings_changed alias.
    expect(SESSION_EVENT_TYPES.has("settings_changed")).toBe(false);
  });

  it("reports prepare-phase steps with an optional elapsed clock", () => {
    const step: ServerEvent = { type: "prepare_progress", step: "memory" };
    const timed: ServerEvent = { type: "prepare_progress", step: "memory", elapsedMs: 1200 };
    expect(step).toEqual({ type: "prepare_progress", step: "memory" });
    expect(timed.type === "prepare_progress" && timed.elapsedMs).toBe(1200);
  });

  it("lets chat_op_started name the op a takeover replaced", () => {
    const plain: ServerEvent = { type: "chat_op_started", opId: "op-2" };
    const takeover: ServerEvent = { type: "chat_op_started", opId: "op-2", supersedes: "op-1" };
    expect(plain).toEqual({ type: "chat_op_started", opId: "op-2" });
    expect(takeover.type === "chat_op_started" && takeover.supersedes).toBe("op-1");
  });

  it("carries optional op attribution on the live envelopes a client must route", () => {
    const attributed: ServerEvent[] = [
      { type: "stream", delta: "hi", opId: "op-1" },
      { type: "stream", replace: true, text: "hi", opId: "op-1" },
      { type: "reasoning", delta: "think", opId: "op-1" },
      { type: "reasoning", replace: true, text: "think", opId: "op-1" },
      { type: "tool_start", toolName: "bash", args: {}, opId: "op-1" },
      { type: "tool_progress", toolName: "bash", message: "running", opId: "op-1" },
      { type: "tool_end", toolName: "bash", result: "ok", allowed: true, opId: "op-1" },
      { type: "tool_chip", chip: { kind: "blocked-by-op", label: "Prior op" }, opId: "op-1" },
      { type: "done", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, opId: "op-1" },
      { type: "error", message: "boom", opId: "op-1" },
      { type: "stopped", reason: "cancelled", opId: "op-1" },
    ];
    // Every one of these must still be relayable — attribution is additive,
    // not a new event family.
    for (const event of attributed) {
      expect(event.type in ALL_SERVER_EVENT_TYPES).toBe(true);
      expect(() => validateRelayPayload("session-event", event, "op-1")).not.toThrow();
    }
    expect(attributed).toHaveLength(11);
  });

  it("keeps op attribution optional so pre-attribution emitters stay valid", () => {
    const legacy: ServerEvent[] = [
      { type: "stream", delta: "hi" },
      { type: "tool_end", toolName: "bash", result: "ok", allowed: true },
      { type: "error", message: "boom" },
    ];
    for (const event of legacy) {
      expect("opId" in event).toBe(false);
      expect(() => validateRelayPayload("session-event", event, "op-1")).not.toThrow();
    }
  });
});
