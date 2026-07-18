// CROSS-SEAM CONTRACT TEST (C3) — batch dispatch × executeToolCalls
// taint-ordering invariants.
//
// The two seams under contract:
//   1. src/canonical-loop/turn-loop/dispatch-tools.ts — the turn lane. For a
//      multi-call turn it must hand the WHOLE list to
//      makeChatToolDispatcher.dispatchBatch (src/canonical-loop/
//      chat-tool-dispatcher.ts), i.e. ONE executeToolCalls invocation. The
//      turn lane must DELEGATE concurrency decisions; it must never build its
//      own Promise.all over tool calls.
//   2. src/tool-execution/execute-tool.ts — the canonical batcher inside
//      executeToolCalls. isParallelSafe (readOnly || concurrencySafe) picks
//      batch candidates; the R4-09 gate-atomicity guard (isBatchCompatible)
//      must NEVER put an egress-class tool (hasCapability(name, "egress"))
//      and a sensitive-read / worktree-path-class tool in the same
//      Promise.all batch.
//
// The contract, in one line: the turn lane delegates concurrency to
// executeToolCalls's batcher; the batcher never co-batches read-class with
// egress-class; and no sink tool (shell / workspace-write) may carry a
// parallel flag.
//
// WHY it is security-load-bearing: a sensitive read taints the session in its
// sandbox/audit phase only when the call COMPLETES; an egress tool's
// pre-dispatch taint gate reads that floor when the call STARTS. Co-batching
// the two makes enforcement completion-order-dependent —
// [read('~/.ssh/id_rsa'), web_fetch(...)] could exfiltrate through the race.
// Because the guard spans two modules, an edit to EITHER seam alone (e.g.
// the turn lane growing its own parallelism, or the batcher losing the class
// split) silently reopens the race while each module still "looks right" in
// isolation. That is exactly what this file pins.
//
// IF THIS TEST FAILS after an edit to either seam: the edit broke a
// cross-seam security contract. Fix the seam — do NOT weaken this test.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { dispatchTools } from "./dispatch-tools.js";
import { makeChatToolDispatcher } from "../chat-tool-dispatcher.js";
import {
  registerToolDispatcherForOp,
  unregisterToolDispatcherForOp,
  unregisterToolsForOp,
} from "../runtime.js";
import { setAriRequired } from "../../ari-kernel/state.js";
import {
  CAPABILITY_CLASS_MEMBERS,
  hasCapability,
  WORKTREE_PATH_TOOLS,
} from "../../tool-registry.js";
import { allTools } from "../../tools/registry-build.js";
import { webFetchTool } from "../../tools/web-fetch.js";
import { createHttpRequestTool } from "../../tools/http-request.js";
import { createBrowserTools } from "../../tools/browser-tools/index.js";
import type { ToolCall } from "../contract-types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 — registry-level invariants (data-anchored to the REAL tool sources;
// no copied tables). These are the cheap tripwires: they go red the moment
// someone flags a sink tool parallel-safe, before any scheduling bug even
// needs to be provoked.
// ─────────────────────────────────────────────────────────────────────────────

describe("registry invariants — no sink tool is parallel-flagged", () => {
  it("web_fetch carries NEITHER readOnly NOR concurrencySafe", () => {
    // web_fetch sits on the audit-phase restricted-tools hard block
    // (audit-tool-call.ts:95 — threatEngine.isRestricted() blocks
    // http_request/web_fetch/browser). That restriction is evaluated when the
    // CALL runs; the threat level that trips isRestricted() is raised by
    // OTHER calls (e.g. a sensitive read) as they complete. If web_fetch were
    // parallel-flagged, it could ride the same Promise.all as the very call
    // whose completion elevates the session — the hard block becomes
    // completion-order-dependent and can be raced past. Keeping the flag OFF
    // forces web_fetch into its own sequential slot AFTER prior calls have
    // finished (and recorded their taint / threat contribution).
    //
    // NOTE: `effect: { class: "read-only" }` on web_fetch is RETRY semantics
    // (ToolEffect), not the parallel-batching flag — isParallelSafe reads
    // `readOnly`/`concurrencySafe` only. The two must not be conflated.
    expect(webFetchTool.name).toBe("web_fetch");
    expect(webFetchTool.readOnly).toBeUndefined();
    expect(webFetchTool.concurrencySafe).toBeUndefined();

    // Same object must be what the static registry bundles.
    const registered = allTools.find((t) => t.name === "web_fetch");
    expect(registered).toBeDefined();
    expect(registered?.readOnly).toBeUndefined();
    expect(registered?.concurrencySafe).toBeUndefined();
  });

  it("bash / self_edit / write / http_request / browser are not parallel-flagged", () => {
    // Statically-bundled sinks: anchor to the live allTools list.
    for (const name of ["bash", "self_edit", "write"]) {
      const tool = allTools.find((t) => t.name === name);
      expect(tool, `${name} must exist in the static registry`).toBeDefined();
      expect(tool?.readOnly, `${name}.readOnly`).toBeFalsy();
      expect(tool?.concurrencySafe, `${name}.concurrencySafe`).toBeFalsy();
    }
    // http_request is factory-built (plugins.ts wires it with the secrets
    // store); assert on the factory's output — same definition object shape.
    const httpRequest = createHttpRequestTool();
    expect(httpRequest.name).toBe("http_request");
    expect(httpRequest.readOnly).toBeFalsy();
    expect(httpRequest.concurrencySafe).toBeFalsy();
    // browser is registered through the runtime path, not allTools — build it
    // from its real factory.
    const [browser] = createBrowserTools();
    expect(browser.name).toBe("browser");
    expect(browser.readOnly).toBeFalsy();
    expect(browser.concurrencySafe).toBeFalsy();
  });

  it("no parallel-flagged tool in the live registry is a shell or workspace-write sink", () => {
    // "No sink ever becomes parallel": every tool that isParallelSafe would
    // batch (readOnly || concurrencySafe) must stay OUT of the shell and
    // workspace-write capability classes. (There is no separate risk-tier
    // table in this codebase — the capability classes in tool-registry.ts ARE
    // the sink taxonomy, so we assert against those exported members
    // directly.) A flagged shell/write tool would let the batcher run a
    // mutation concurrently with the reads it batches — and concurrently
    // with the gates that assume sequential completion.
    const flagged = allTools.filter((t) => t.readOnly || t.concurrencySafe);
    // Non-vacuous: the read/search family is flagged today. If this ever hits
    // zero, someone stripped the flags wholesale — see the overlap test below
    // for why that "fix" is also wrong.
    expect(flagged.length).toBeGreaterThan(0);

    const shell = new Set(CAPABILITY_CLASS_MEMBERS.shell);
    const workspaceWrite = new Set(CAPABILITY_CLASS_MEMBERS["workspace-write"]);
    const offenders = flagged
      .map((t) => t.name)
      .filter(
        (name) =>
          shell.has(name) ||
          workspaceWrite.has(name) ||
          hasCapability(name, "shell") ||
          hasCapability(name, "workspace-write"),
      );
    expect(
      offenders,
      `parallel-flagged sink tool(s): ${offenders.join(", ")} — a shell/workspace-write ` +
        `sink must never be eligible for Promise.all batching`,
    ).toEqual([]);

    // Belt-and-braces: a readOnly-flagged tool declaring static mutation
    // effect semantics is self-contradictory (effect is the retry taxonomy;
    // a "read-only batching" tool with a mutation effect class means one of
    // the two declarations is lying).
    for (const t of flagged) {
      if (t.effect && typeof t.effect === "object") {
        expect(t.effect.class, `${t.name}: readOnly/concurrencySafe with mutation effect`).toBe("read-only");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 — behavioral cross-seam proof, driven through the REAL path:
// dispatchTools → makeChatToolDispatcher.dispatchBatch → executeToolCalls.
// Harness mirrors dispatch-tools.test.ts (same fixture technique: fake tools
// registered on a per-op chat dispatcher; class membership comes from the
// fixture NAME resolving against the real tool-registry sets, which the tests
// sanity-anchor before relying on).
// ─────────────────────────────────────────────────────────────────────────────

const OPS_BASE = join(homedir(), ".lax", "operations");
const trackedOpIds: string[] = [];
let seq = 0;
function freshOpId(): string { return `op_batch_contract_test_${seq++}_${process.pid}`; }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/** Legacy-envelope fake tool; flags control parallel-safety, the NAME controls
 *  capability-class membership (isEgressClass/isReadClass key on the name via
 *  the real tool-registry sets — so a fixture named `glob` IS read-class and a
 *  fixture named `browser_*` IS egress-class to the batcher under test). */
function fakeTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<ToolResult>,
  flags?: { readOnly?: boolean; concurrencySafe?: boolean },
): ToolDefinition {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    execute,
    ...flags,
  } as unknown as ToolDefinition;
}

function registerChatDispatcher(opId: string, tools: ToolDefinition[]): void {
  registerToolDispatcherForOp(opId, makeChatToolDispatcher({
    tools,
    security: undefined as never,
    sessionId: `s-${opId}`,
    callContext: "local",
    opId,
  }));
}

function trackOp(opId: string): string {
  trackedOpIds.push(opId);
  return opId;
}

function call(toolCallId: string, tool: string, args: unknown = {}): ToolCall {
  return { toolCallId, tool, args };
}

describe("cross-seam behavior — dispatchTools batch lane through the real R4-09 batcher", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => {
    setAriRequired(true);
    for (const id of trackedOpIds) {
      const dir = join(OPS_BASE, id);
      if (existsSync(dir)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });
  afterEach(() => {
    for (const id of trackedOpIds) {
      unregisterToolDispatcherForOp(id);
      unregisterToolsForOp(id);
    }
  });

  it("read-class and egress-class tools NEVER overlap, even when BOTH are parallel-flagged (R4-09)", async () => {
    // THE invariant. Both fixtures are flagged readOnly:true — to
    // isParallelSafe they are batchable — so ONLY isBatchCompatible's
    // read×egress split keeps them sequential. Fixture class membership is
    // taken from the REAL registry sets via the names:
    //   "glob"                   → read-class (WORKTREE_PATH_TOOLS + sensitive-read)
    //   "browser_probe_contract" → egress-class (browser_* prefix rule)
    // Sanity-anchor that resolution so a registry rename fails HERE loudly
    // instead of silently turning this test vacuous:
    expect(WORKTREE_PATH_TOOLS.has("glob")).toBe(true);
    expect(hasCapability("browser_probe_contract", "egress")).toBe(true);

    // Deferred-promise gate, INVERTED from the overlap test: the ingest tool
    // parks on a gate that only the egress tool's START can release (plus a
    // real-time escape so the CORRECT schedule terminates). Failure modes
    // this cannot pass under:
    //   - R4-09 removed / isBatchCompatible weakened → both ride one
    //     Promise.all → egress's execute starts while ingest is parked →
    //     egressStartedBeforeIngestDone=true AND coBatched=true → red.
    //   - dispatch-tools.ts grows its own Promise.all over the turn's calls
    //     (bypassing the batcher) → same overlap → red.
    // Under the CORRECT schedule the egress tool cannot start until ingest
    // fully resolved, so the gate stays unreleased until the escape fires and
    // both flags stay false. (The sleep is the escape hatch, not the proof.)
    const opId = trackOp(freshOpId());
    let releaseGate!: () => void;
    const gate = new Promise<void>(r => { releaseGate = r; });
    let coBatched = false;
    let ingestDone = false;
    let egressStartedBeforeIngestDone = false;

    // The gate resolves in BOTH schedules (the egress tool always runs
    // eventually) — what distinguishes them is WHEN: a release that arrives
    // while ingest is still parked (ingestDone=false) means the two executes
    // were in flight together, i.e. one Promise.all.
    gate.then(() => { if (!ingestDone) coBatched = true; });
    const ingest = fakeTool("glob", async () => {
      await Promise.race([gate, sleep(400)]);
      ingestDone = true;
      return { content: "INGEST_DONE", isError: false };
    }, { readOnly: true });
    const egress = fakeTool("browser_probe_contract", async () => {
      egressStartedBeforeIngestDone = !ingestDone;
      releaseGate();
      return { content: "EGRESS_DONE", isError: false };
    }, { readOnly: true });

    registerChatDispatcher(opId, [ingest, egress]);
    const out = await dispatchTools(opId, 0, [
      call("c-ingest", "glob"),
      call("c-egress", "browser_probe_contract"),
    ]);

    expect(coBatched).toBe(false); // never in one Promise.all
    expect(egressStartedBeforeIngestDone).toBe(false); // ingest completed (and could taint) first
    // Original call order and per-call results survive the split.
    expect(out.toolMessages.map(m => (m.content as { toolCallId: string }).toolCallId))
      .toEqual(["c-ingest", "c-egress"]);
    expect(out.toolSummary.every(s => s.resultStatus === "ok")).toBe(true);
  });

  it("two same-class (read) parallel-flagged tools DO overlap — the batcher still batches", async () => {
    // Guards the other direction: someone "fixing" R4-09 by serializing
    // EVERYTHING would pass the test above while silently killing parallel
    // dispatch. Here both fixtures are read-class ("grep" and
    // "structural_search" — both in the real sensitive-read/worktree sets),
    // so isBatchCompatible must let them share one Promise.all. If the
    // batcher serialized them, tool A would sit on its gate until the 1500ms
    // escape fires, flagging serialized=true → red.
    expect(WORKTREE_PATH_TOOLS.has("grep")).toBe(true);
    expect(WORKTREE_PATH_TOOLS.has("structural_search")).toBe(true);

    const opId = trackOp(freshOpId());
    let releaseGate!: () => void;
    const gate = new Promise<void>(r => { releaseGate = r; });
    let serialized = false;

    const readA = fakeTool("grep", async () => {
      await Promise.race([gate, sleep(1500).then(() => { serialized = true; })]);
      return { content: "A_DONE", isError: false };
    }, { readOnly: true });
    const readB = fakeTool("structural_search", async () => {
      releaseGate();
      return { content: "B_DONE", isError: false };
    }, { readOnly: true });

    registerChatDispatcher(opId, [readA, readB]);
    const out = await dispatchTools(opId, 0, [
      call("c-a", "grep"),
      call("c-b", "structural_search"),
    ]);

    expect(serialized).toBe(false); // truly concurrent within the read class
    expect(out.toolMessages.map(m => (m.content as { toolCallId: string }).toolCallId))
      .toEqual(["c-a", "c-b"]); // input order, not completion order
    expect(out.toolSummary.every(s => s.resultStatus === "ok")).toBe(true);
  });

  it("an unflagged tool (web_fetch-shaped) is strictly serialized behind a flagged read, original order", async () => {
    // The fixture reuses the real name "web_fetch" WITHOUT flags — exactly
    // how the real definition ships (pinned in Part 1). Scheduling bug this
    // catches: if isParallelSafe stopped gating batch membership (or someone
    // flags web_fetch parallel-safe at either seam), the fetch's execute
    // would start before the read finished — order[] would record
    // "fetch:start" before "read:end" → red.
    const opId = trackOp(freshOpId());
    const order: string[] = [];
    const readTool = fakeTool("glob", async () => {
      order.push("read:start");
      await sleep(50);
      order.push("read:end");
      return { content: "READ", isError: false };
    }, { readOnly: true });
    const fetchTool = fakeTool("web_fetch", async () => {
      order.push("fetch:start");
      return { content: "FETCH", isError: false };
    }); // no readOnly/concurrencySafe — matches the real web_fetch definition

    registerChatDispatcher(opId, [readTool, fetchTool]);
    const out = await dispatchTools(opId, 0, [call("c-1", "glob"), call("c-2", "web_fetch")]);

    expect(order).toEqual(["read:start", "read:end", "fetch:start"]);
    expect(out.toolMessages.map(m => (m.content as { toolCallId: string }).toolCallId))
      .toEqual(["c-1", "c-2"]);
    expect(out.toolSummary.every(s => s.resultStatus === "ok")).toBe(true);
  });
});
