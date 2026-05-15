/**
 * Issue 09 — Anthropic adapter conformance.
 * docs/issues/canonical-loop/09-anthropic-adapter-conformance.md (PRD §15)
 *
 * Coverage:
 *   - Conformance items A–I against AnthropicAdapter using a programmable
 *     mock transport (no live API / subprocess calls).
 *   - Provider-error → canonical `error` adapter_report mapping.
 *   - Stream chunks → canonical `stream_chunk`; assistant text accumulates
 *     into a single `message_finalized`.
 *   - Tool-call round trip integrates with the canonical loop's
 *     tool-dispatch boundary; tool_result message in turn 2 input.
 *   - `provider_state` envelope shape, sandbox-cleanliness, size cap.
 *   - End-to-end via canonical-loop runtime: cancel mid-stream actually
 *     aborts the transport; partial turn discarded.
 *   - Secret redaction: API keys in error messages are scrubbed.
 *   - No secret material on persisted op artifacts.
 *   - Flag-OFF legacy submit path is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AnthropicAdapter,
  ANTHROPIC_ADAPTER_NAME,
  ANTHROPIC_ADAPTER_VERSION,
  PROVIDER_STATE_MAX_BYTES_DEFAULT,
  canonicalLoopEntry,
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
  setLeaseConfig,
  resetLeaseConfig,
  decideSubmitRouting,
  readCanonicalEvents,
  readOpMessages,
  readOpTurn,
  subscribeOpStream,
  opCancel,
  type CanonicalEvent,
  type AnthropicTransport,
  type TransportEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";
import {
  runConformance,
  type ConformanceItemId,
} from "./canonical-loop/conformance.js";
import {
  MockAnthropicTransport,
  planText,
  planToolCall,
  planError,
  planLongStream,
} from "./canonical-loop/anthropic-mock-transport.js";

const ADAPTER_SOURCE = join(
  process.cwd(),
  "src",
  "canonical-loop",
  "adapters",
  "anthropic.ts",
);

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 200, heartbeatIntervalMs: 50 });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
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
    id: track(newOpId(`it09_${label}`)),
    type: "freeform",
    task: `issue-09 ${label}`,
    contextPack: {} as Op["contextPack"],
    lane,
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-issue-09",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitState(opId: string, target: "succeeded" | "failed" | "cancelled", timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = readOp(opId);
    if (op?.canonical?.state === target) return;
    if (Date.now() > deadline) {
      const events = readCanonicalEvents(opId).map(e => e.type).join(",");
      throw new Error(`awaitState(${target}) timed out for ${opId} — events=[${events}], state=${op?.canonical?.state}`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

function bodyOf<T = Record<string, unknown>>(e: CanonicalEvent): T {
  return (e.body ?? {}) as T;
}

// ── PRD §15 conformance suite items A–I ───────────────────────────────────

describe("Issue 09 — Anthropic adapter conformance suite (A–I)", () => {
  // The conformance harness was built provider-agnostic. We seed the mock
  // transport with per-item scripts via a `prepare` hook: each conformance
  // item has its own injection point into the runner.
  it("passes all A–I items with a mock transport", async () => {
    // Item-scripts: each ConformanceItemId maps to the plans the runner
    // will dispatch on every successive `runTurn` of that item. Items
    // that need a fresh adapter per call get fresh plans below.
    const itemPlans: Record<ConformanceItemId, ReturnType<typeof planText>[]> = {
      A: [planText("hello"), planText("hi"), planText("hi"), planText("hi")],
      B: [
        planToolCall({ id: "tc-1", name: "ping", arguments: '{"who":"world"}' }),
        planText("pong received"),
      ],
      C: [planText("cold-start ok")],
      D: [planText("turn-0 text"), planText("turn-1 text")],
      E: [planLongStream(200, 25)],
      F: [planText("only one")],
      G: [planText("done"), planText("done")],
      H: [planText("ok")],
      I: [planText("audit-only")],
    };

    const results = await runConformance(
      () => {
        // Each call gets a fresh adapter + fresh transport with all the
        // plans that item needs. The runner does NOT share the adapter
        // across items, so this is safe.
        const transport = new MockAnthropicTransport({ plans: [] });
        const adapter = new AnthropicAdapter({
          transport,
          model: "claude-test-mock",
        });
        // Stash transport on adapter for the prepare hook (TS-friendly via cast).
        (adapter as unknown as { _testTransport: MockAnthropicTransport })._testTransport = transport;
        return adapter;
      },
      {
        adapterSourcePath: ADAPTER_SOURCE,
        prepare: (adapter, item) => {
          const transport = (adapter as unknown as { _testTransport: MockAnthropicTransport })._testTransport;
          for (const plan of itemPlans[item] ?? []) transport.enqueue(plan);
        },
      },
    );

    const failed = results.filter(r => r.status === "failed");
    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.log("conformance failures:", failed.map(f => `${f.item}: ${f.diagnostic}`).join("\n"));
    }
    expect(failed).toEqual([]);

    const skipped = results.filter(r => r.status === "skipped");
    expect(skipped).toEqual([]); // adapterSourcePath provided → I should run.
    const itemI = results.find(r => r.item === "I");
    expect(itemI?.status).toBe("passed");
  });
});

// ── Direct adapter-shape unit checks ─────────────────────────────────────

describe("Issue 09 — adapter-contract shape", () => {
  it("exposes name + version + runTurn + abort", () => {
    const a = new AnthropicAdapter({ transport: new MockAnthropicTransport({ plans: [] }) });
    expect(a.name).toBe(ANTHROPIC_ADAPTER_NAME);
    expect(a.version).toBe(ANTHROPIC_ADAPTER_VERSION);
    expect(typeof a.runTurn).toBe("function");
    expect(typeof a.abort).toBe("function");
  });

  it("returns a provider_state envelope with the correct adapterName/Version", async () => {
    const transport = new MockAnthropicTransport({ plans: [planText("hello")] });
    const adapter = new AnthropicAdapter({ transport });
    const result = await adapter.runTurn(
      { opId: "shape", turnIdx: 0, messages: [], tools: [] },
      () => { /* drop */ },
    );
    expect(result.providerState.adapterName).toBe(ANTHROPIC_ADAPTER_NAME);
    expect(result.providerState.adapterVersion).toBe(ANTHROPIC_ADAPTER_VERSION);
    expect(result.providerState.providerPayload).toMatchObject({ lastTurnIdx: 0 });
  });
});

// ── Stream → canonical mapping ───────────────────────────────────────────

describe("Issue 09 — provider stream → canonical adapter_reports", () => {
  it("text deltas yield stream_chunk reports AND a single accumulated message_finalized", async () => {
    const transport = new MockAnthropicTransport({ plans: [planText("Hel", "lo, ", "world")] });
    const adapter = new AnthropicAdapter({ transport });
    const reports: { kind: string; body?: unknown; message?: unknown }[] = [];
    await adapter.runTurn(
      { opId: "stream-mapping", turnIdx: 0, messages: [], tools: [] },
      r => reports.push(r as never),
    );
    const chunks = reports.filter(r => r.kind === "stream_chunk");
    expect(chunks).toHaveLength(3);
    const finalized = reports.filter(r => r.kind === "message_finalized");
    expect(finalized).toHaveLength(1);
    const m = (finalized[0] as { message: { role: string; content: { text: string } } }).message;
    expect(m.role).toBe("assistant");
    expect(m.content.text).toBe("Hello, world");
  });

  it("tool_call events become tool_call_requested with parsed args", async () => {
    const transport = new MockAnthropicTransport({
      plans: [planToolCall({ id: "tc-7", name: "search", arguments: '{"q":"abc"}' })],
    });
    const adapter = new AnthropicAdapter({ transport });
    const reports: { kind: string; call?: { tool: string; args: unknown; toolCallId: string } }[] = [];
    const result = await adapter.runTurn(
      { opId: "tool-call", turnIdx: 0, messages: [], tools: [] },
      r => reports.push(r as never),
    );
    const tools = reports.filter(r => r.kind === "tool_call_requested");
    expect(tools).toHaveLength(1);
    expect(tools[0].call!.tool).toBe("search");
    expect(tools[0].call!.toolCallId).toBe("tc-7");
    expect(tools[0].call!.args).toEqual({ q: "abc" });
    // Tool calls outstanding → terminalReason undefined (worker proceeds to next turn).
    expect(result.terminalReason).toBeUndefined();
  });

  it("provider error events surface as error adapter_reports and never throw", async () => {
    const transport = new MockAnthropicTransport({
      plans: [planError("rate_limited", "429 Too Many Requests", true)],
    });
    const adapter = new AnthropicAdapter({ transport });
    const reports: { kind: string; code?: string; message?: string; retryable?: boolean }[] = [];
    let threw = false;
    let result;
    try {
      result = await adapter.runTurn(
        { opId: "error-flow", turnIdx: 0, messages: [], tools: [] },
        r => reports.push(r as never),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const errs = reports.filter(r => r.kind === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("rate_limited");
    expect(errs[0].retryable).toBe(true);
    expect(result?.terminalReason).toBe("error");
  });
});

// ── Secret redaction ─────────────────────────────────────────────────────

describe("Issue 09 — no secrets in event bodies or persisted artifacts", () => {
  const secretApiKey = "sk-ant-api03-LEAKEDSECRETkey1234567890ABCDEF";
  const secretOauth = "oauth:abc123XYZ.def456";

  it("error messages with API keys are redacted in adapter_reports", async () => {
    const transport = new MockAnthropicTransport({
      plans: [planError("transport_error", `auth failed for ${secretApiKey} via ${secretOauth}`)],
    });
    const adapter = new AnthropicAdapter({ transport });
    const reports: { kind: string; message?: string }[] = [];
    await adapter.runTurn(
      { opId: "redact", turnIdx: 0, messages: [], tools: [] },
      r => reports.push(r as never),
    );
    const errs = reports.filter(r => r.kind === "error");
    expect(errs[0].message).not.toContain(secretApiKey);
    expect(errs[0].message).not.toContain(secretOauth);
    expect(errs[0].message).toContain("[REDACTED");
  });

  it("provider_state envelope never contains the auth token or any sk-ant-* string", async () => {
    const transport = new MockAnthropicTransport({ plans: [planText("ok")] });
    const adapter = new AnthropicAdapter({ transport });
    const result = await adapter.runTurn(
      { opId: "state-no-secrets", turnIdx: 0, messages: [], tools: [] },
      () => { /* drop */ },
    );
    const json = JSON.stringify(result.providerState);
    expect(json).not.toMatch(/sk-ant-/);
    expect(json).not.toMatch(/oauth:/);
    expect(json).not.toMatch(/Bearer\s+/i);
  });

  it("end-to-end op artifacts (events + op_turns + op_messages) carry no secret material", async () => {
    const transport = new MockAnthropicTransport({
      plans: [planError("auth_unavailable", `bad key ${secretApiKey}`)],
    });
    const adapter = new AnthropicAdapter({ transport });
    const op = mkOp("redact-e2e");
    registerAdapterForOp(op.id, () => adapter);
    canonicalLoopEntry(op);
    await awaitState(op.id, "failed", 3_000);

    const events = readCanonicalEvents(op.id);
    for (const e of events) {
      const body = JSON.stringify(e.body ?? {});
      expect(body).not.toContain(secretApiKey);
      expect(body).not.toContain(secretOauth);
    }
    const messages = readOpMessages(op.id);
    expect(JSON.stringify(messages)).not.toContain(secretApiKey);
    const turn0 = readOpTurn(op.id, 0);
    expect(JSON.stringify(turn0 ?? {})).not.toContain(secretApiKey);
  });
});

// ── End-to-end through the canonical loop ────────────────────────────────

describe("Issue 09 — adapter integrated with canonical-loop runtime", () => {
  it("end-to-end happy path: text turn → succeeded with op_turns + op_messages persisted", async () => {
    const transport = new MockAnthropicTransport({ plans: [planText("Hello", " from", " mock")] });
    const adapter = new AnthropicAdapter({ transport });
    const op = mkOp("e2e-happy");
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitState(op.id, "succeeded");

    const events = readCanonicalEvents(op.id);
    const types = events.map(e => e.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("message_appended");
    expect(types).toContain("turn_committed");
    const stateChanges = events.filter(e => e.type === "state_changed").map(e => bodyOf<{ to: string }>(e).to);
    expect(stateChanges).toContain("succeeded");

    const turn = readOpTurn(op.id, 0);
    expect(turn).toBeTruthy();
    expect(turn!.providerState.adapterName).toBe("anthropic");

    const messages = readOpMessages(op.id);
    // Turn-0 user seed precedes the assistant response.
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("provider error → op transitions to failed via the canonical state machine", async () => {
    const transport = new MockAnthropicTransport({
      plans: [planError("rate_limited", "429 from upstream", true)],
    });
    const adapter = new AnthropicAdapter({ transport });
    const op = mkOp("e2e-error");
    registerAdapterForOp(op.id, () => adapter);

    canonicalLoopEntry(op);
    await awaitState(op.id, "failed");

    const events = readCanonicalEvents(op.id);
    const errEvents = events.filter(e => e.type === "error");
    expect(errEvents.length).toBeGreaterThanOrEqual(1);
    const failedTransition = events.find(e =>
      e.type === "state_changed" && bodyOf<{ to: string }>(e).to === "failed",
    );
    expect(failedTransition).toBeDefined();
  });

  it("opCancel mid-stream aborts the transport; partial turn discarded (no op_turns row, no commit event)", async () => {
    const transport = new MockAnthropicTransport({ plans: [planLongStream(400, 20)] });
    const adapter = new AnthropicAdapter({ transport });
    const op = mkOp("e2e-cancel");
    registerAdapterForOp(op.id, () => adapter);

    const firstChunk = new Promise<void>((resolve) => {
      const off = subscribeOpStream(op.id, () => { off(); resolve(); });
    });

    canonicalLoopEntry(op);
    await firstChunk;

    const r = opCancel(op.id, "test-actor");
    expect(r.ok).toBe(true);

    await awaitState(op.id, "cancelled", 2_000);

    const events = readCanonicalEvents(op.id);
    expect(events.some(e => e.type === "turn_committed")).toBe(false);
    expect(readOpTurn(op.id, 0)).toBeNull();
  });
});

// ── Resume flow: providerState round-trip across turns ───────────────────

describe("Issue 09 — providerState resume across turns", () => {
  it("turn 2 receives the providerState envelope returned by turn 1", async () => {
    const transport = new MockAnthropicTransport({
      plans: [
        planToolCall({ id: "tc-9", name: "ping", arguments: "{}" }),
        planText("done now"),
      ],
    });
    const adapter = new AnthropicAdapter({ transport });

    // Turn 1: tool call → terminalReason undefined.
    const r1 = await adapter.runTurn(
      { opId: "resume", turnIdx: 0, messages: [], tools: [] },
      () => { /* drop */ },
    );
    expect(r1.terminalReason).toBeUndefined();
    expect(r1.providerState.providerPayload).toMatchObject({ pendingTools: 1 });

    // Turn 2: feed back a tool_result canonical message + prior providerState.
    const r2 = await adapter.runTurn(
      {
        opId: "resume",
        turnIdx: 1,
        messages: [{
          messageId: "tr-1",
          role: "tool_result",
          content: { toolCallId: "tc-9", result: { ok: true } },
        }],
        tools: [],
        providerState: r1.providerState,
      },
      () => { /* drop */ },
    );
    expect(r2.terminalReason).toBe("done");
    // Transport saw the tool_result message in turn 2's request.
    const turn2Req = transport.requests[1];
    expect(turn2Req.messages.some(m => m.role === "tool" && m.toolCallId === "tc-9")).toBe(true);
  });
});

// ── Provider state size cap (PRD §21) ────────────────────────────────────

describe("Issue 09 — provider_state size cap", () => {
  it("oversize provider_state surfaces a clear error report and terminalReason='error'", async () => {
    // Force the cap very low so we can blow past it deterministically.
    const transport = new MockAnthropicTransport({ plans: [planText("ok")] });
    const adapter = new AnthropicAdapter({
      transport,
      providerStateMaxBytes: 50, // 50 bytes — the standard envelope alone exceeds this.
    });

    const reports: { kind: string; code?: string }[] = [];
    const result = await adapter.runTurn(
      { opId: "size-cap", turnIdx: 0, messages: [], tools: [] },
      r => reports.push(r as never),
    );
    expect(reports.some(r => r.kind === "error" && r.code === "provider_state_oversize")).toBe(true);
    expect(result.terminalReason).toBe("error");
    // Replacement minimal envelope still has the canonical adapterName/Version.
    expect(result.providerState.adapterName).toBe("anthropic");
  });

  it("default cap is 256 KB", () => {
    expect(PROVIDER_STATE_MAX_BYTES_DEFAULT).toBe(256 * 1024);
  });
});

// ── Audit: no DB / event / worker / child_process imports in adapter ─────

describe("Issue 09 — adapter sandbox audit (PRD §15 item I)", () => {
  it("conformance item I passes for AnthropicAdapter", async () => {
    const results = await runConformance(
      () => new AnthropicAdapter({ transport: new MockAnthropicTransport({ plans: [planText("x")] }) }),
      { items: ["I"], adapterSourcePath: ADAPTER_SOURCE },
    );
    const itemI = results[0];
    if (itemI.status !== "passed") {
      // eslint-disable-next-line no-console
      console.log("audit diagnostic:", itemI.diagnostic);
    }
    expect(itemI.status).toBe("passed");
  });
});

// ── Flag OFF compatibility ───────────────────────────────────────────────

describe("flag OFF: Anthropic adapter does not affect legacy submit path", () => {
  beforeEach(() => {
    // Under the inverted default, OFF must be explicit.
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "0";
  });
  afterEach(() => {
    delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
  });

  it("decideSubmitRouting still routes legacy when flag OFF", () => {
    const r = decideSubmitRouting({ lane: "interactive" });
    expect(r.route).toBe("legacy");
    expect(r.flagValue).toBe(false);
  });
});

// ── runTurn must never throw on transport-level exceptions (item H) ─────

describe("Issue 09 — runTurn never throws (PRD §15 item H)", () => {
  it("transport that rejects synchronously becomes an error adapter_report, not a thrown exception", async () => {
    const broken: AnthropicTransport = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("synthetic transport blow-up sk-ant-api03-LEAKEDSECRETxyz");
      },
    };
    const adapter = new AnthropicAdapter({ transport: broken });
    const reports: { kind: string; code?: string; message?: string }[] = [];
    let threw = false;
    let result: { terminalReason?: string } | null = null;
    try {
      result = await adapter.runTurn(
        { opId: "throw-h", turnIdx: 0, messages: [], tools: [] },
        r => reports.push(r as never),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(reports.some(r => r.kind === "error" && r.code === "transport_exception")).toBe(true);
    // Secret in the thrown message is redacted in the report.
    const errMessage = reports.find(r => r.kind === "error")?.message ?? "";
    expect(errMessage).not.toMatch(/sk-ant-api03-LEAKEDSECRET/);
    expect(result?.terminalReason).toBe("error");
  });
});
