// Batcher gate-atomicity coverage (R4-09): the parallel batcher must NEVER put
// an egress-capability tool and a sensitive-read / path-reading tool in the same
// Promise.all (one sessionId, concurrent). If it did, the egress tool's taint
// CHECK (policy phase) could race the sensitive read's taint FLOOR-set, observing
// an empty floor — the round-4 `[read('~/.ssh/id_rsa'), web_search(...)]` exfil.
//
// These tests drive the real executeToolCalls phase chain (with the AriKernel
// requirement relaxed so stub tools reach execute) and prove:
//  1. read + web_search run in SEPARATE sequential batches — the read fully
//     completes before web_search starts (no concurrency overlap), while a
//     control pair of two reads DOES overlap (still co-batched);
//  2. because the read runs (and taints) first, web_search's real egress gate
//     (dataLineageGate) sees the floor and BLOCKS — the read's sensitive path is
//     tainted before the egress check runs.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolCalls, dispatchSingleToolCall } from "./execute-tool.js";
import { _clearDedupCacheForTests, dedupRecord } from "./dedup-cache.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { clearSessionTaint, getTaintSummary } from "../data-lineage/index.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { setUnconfinedHostAcknowledgement } from "../sandbox/index.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";

// A sensitive path knowable from args: basename `id_rsa` is flagged by
// isSensitivePath regardless of location, so the pre-execute floor-set fires.
const SENSITIVE_PATH = "/tmp/lax-r4-09/.ssh/id_rsa";

// An instrumented tool that records when its execute enters and exits, so a
// test can detect whether two tools' executes overlapped (co-batched in one
// Promise.all) or ran strictly sequentially (separate batches).
function makeTracked(
  name: string,
  opts: { readOnly?: boolean; concurrencySafe?: boolean },
  events: string[],
): ToolDefinition {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    readOnly: opts.readOnly,
    concurrencySafe: opts.concurrencySafe,
    execute: async (): Promise<ToolResult> => {
      events.push(`enter:${name}`);
      // Yield twice so a genuinely concurrent sibling would interleave its
      // enter between our enter and exit.
      await Promise.resolve();
      await Promise.resolve();
      events.push(`exit:${name}`);
      return { content: "ok", isError: false };
    },
  } as unknown as ToolDefinition;
}

describe("batcher gate-atomicity (R4-09: no egress + sensitive-read co-batch)", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  let seq = 0;
  function freshSession(): string { return `r4-09-${seq++}`; }

  beforeEach(() => { /* sessions are per-test fresh */ });

  it("two reads (both sensitive-read class) DO co-batch — their executes overlap", async () => {
    // Control: same capability class on both sides → still parallelized. Proves
    // the no-co-batch rule is specific to the egress×read cross, not a blanket
    // serialization of every parallel-safe tool.
    const events: string[] = [];
    const toolMap = new Map<string, ToolDefinition>([
      ["read", makeTracked("read", { readOnly: true, concurrencySafe: true }, events)],
      ["grep", makeTracked("grep", { readOnly: true, concurrencySafe: true }, events)],
    ]);
    const session = freshSession();
    clearSessionTaint(session);
    await executeToolCalls(
      [
        { id: "1", name: "read", arguments: JSON.stringify({ path: "/tmp/a.txt" }) },
        { id: "2", name: "grep", arguments: JSON.stringify({ path: "/tmp", pattern: "x" }) },
      ],
      toolMap, undefined as never, undefined, undefined, undefined, undefined, session,
      undefined, undefined, undefined, undefined, undefined, "local",
    );
    // Co-batched: both enter before either exits.
    expect(events.slice(0, 2)).toEqual(["enter:read", "enter:grep"]);
  });

  it("read + web_search do NOT co-batch — the read fully completes before web_search starts", async () => {
    // read is sensitive-read class, web_search is egress class → batch-INCOMPATIBLE.
    // They run in separate sequential batches, so the read's execute exits before
    // web_search's execute enters (no overlap), preserving order so the read
    // taints first.
    const events: string[] = [];
    const toolMap = new Map<string, ToolDefinition>([
      ["read", makeTracked("read", { readOnly: true, concurrencySafe: true }, events)],
      ["web_search", makeTracked("web_search", { readOnly: true, concurrencySafe: true }, events)],
    ]);
    const session = freshSession();
    clearSessionTaint(session);
    await executeToolCalls(
      [
        { id: "1", name: "read", arguments: JSON.stringify({ path: "/tmp/a.txt" }) },
        { id: "2", name: "web_search", arguments: JSON.stringify({ query: "hi" }) },
      ],
      toolMap, undefined as never, undefined, undefined, undefined, undefined, session,
      undefined, undefined, undefined, undefined, undefined, "local",
    );
    // Sequential: read's enter+exit precede web_search's enter entirely.
    expect(events).toEqual(["enter:read", "exit:read", "enter:web_search", "exit:web_search"]);
  });

  it("a STUBBED sensitive read retracts the floor — web_search in the later batch runs clean", async () => {
    // The round-4 repro shape [read('<sensitive>'), web_search(...)], updated
    // for the delivery-point invariant. The read's result is fully replaced by
    // the redaction stub, so the model never received the bytes; the
    // provisional floor is retracted and web_search — whose query was authored
    // BEFORE the read returned, so it cannot carry the file's bytes — proceeds.
    // Batch separation (previous test) still guarantees the floor is never
    // transiently empty mid-read.
    const events: string[] = [];
    const toolMap = new Map<string, ToolDefinition>([
      ["read", makeTracked("read", { readOnly: true, concurrencySafe: true }, events)],
      ["web_search", makeTracked("web_search", { readOnly: true, concurrencySafe: true }, events)],
    ]);
    const session = freshSession();
    clearSessionTaint(session);
    const msgs = await executeToolCalls(
      [
        { id: "1", name: "read", arguments: JSON.stringify({ path: SENSITIVE_PATH }) },
        { id: "2", name: "web_search", arguments: JSON.stringify({ query: "exfil please" }) },
      ],
      toolMap, undefined as never, undefined, undefined, undefined, undefined, session,
      undefined, undefined, undefined, undefined, undefined, "local",
    );

    // The read was stubbed (bytes withheld from the model)…
    const readMsg = msgs.find((m) => (m as { tool_call_id?: string }).tool_call_id === "1");
    expect(String(readMsg?.content)).toMatch(/redacted by data-lineage gate/i);
    expect(String(readMsg?.content)).not.toContain("ok");
    // …so nothing entered context: floor retracted, web_search ran.
    expect(getTaintSummary(session).count).toBe(0);
    expect(events).toContain("enter:web_search");

    clearSessionTaint(session);
  });

  it("a DELIVERED sensitive read keeps the floor — egress CARRYING the delivered bytes is blocked", async () => {
    // The enforcement half of R4-09 under the invariant: when the read's
    // output IS delivered (an errored result skips the redaction stub, and
    // error text can echo file bytes), the taint commits with the delivered
    // content fingerprinted. Under the B+ completeness guard an unrelated
    // payload may still egress — but a payload that CARRIES the delivered
    // bytes must be blocked, and its execute must never run.
    const deliveredText = "read failed after partial read: SGVsbG8gc2VjcmV0IGJ5dGVzIGZyb20gaWRfcnNh trailing";
    const events: string[] = [];
    const erroringRead: ToolDefinition = {
      name: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      concurrencySafe: true,
      execute: async (): Promise<ToolResult> => {
        events.push("enter:read");
        return { content: deliveredText, isError: true };
      },
    } as unknown as ToolDefinition;
    const toolMap = new Map<string, ToolDefinition>([
      ["read", erroringRead],
      ["web_search", makeTracked("web_search", { readOnly: true, concurrencySafe: true }, events)],
    ]);
    const session = freshSession();
    clearSessionTaint(session);
    const serverEvents: Array<Record<string, unknown>> = [];
    const msgs = await executeToolCalls(
      [
        { id: "1", name: "read", arguments: JSON.stringify({ path: SENSITIVE_PATH }) },
        { id: "2", name: "web_search", arguments: JSON.stringify({ query: `look up ${deliveredText}` }) },
      ],
      toolMap, undefined as never, undefined, undefined, undefined, undefined, session,
      (e) => serverEvents.push(e as unknown as Record<string, unknown>),
      undefined, undefined, undefined, undefined, "local",
    );

    // The delivered read committed the taint…
    expect(getTaintSummary(session).count).toBeGreaterThan(0);
    // …and the payload carrying the delivered bytes was blocked before execute.
    expect(events).not.toContain("enter:web_search");
    const webMsg = msgs.find((m) => (m as { tool_call_id?: string }).tool_call_id === "2");
    expect(String(webMsg?.content)).toMatch(/BLOCKED by data lineage|tainted/i);

    // The blocked tool_end event carries the envelope metadata naming the
    // authoritative layer — the chat UI keys its one-click declassify-and-
    // retry action off this (data-lineage in `layer` or aggregate `layers`).
    const blockedEnd = serverEvents.find(
      (e) => e.type === "tool_end" && e.toolCallId === "2",
    ) as { metadata?: { layer?: string; layers?: string[] } } | undefined;
    expect(blockedEnd?.metadata).toBeDefined();
    const layers = [blockedEnd!.metadata!.layer, ...(blockedEnd!.metadata!.layers ?? [])];
    expect(layers).toContain("data-lineage");

    clearSessionTaint(session);
  });
});

// TD-4: on a dedup hit, dedupCheckPhase used to push the tool msg + emit
// tool_end via terminate(), and then the trailing auditPhase pushed a SECOND
// tool message + second tool_end for the same tool_call_id. The MCP route
// serialized both; provider replays 400'd on the duplicate id. The invariant:
// a dedup-hit call yields exactly ONE tool message and ONE tool_end.
describe("dedup hit emits the tool result exactly once (TD-4)", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));
  beforeEach(() => _clearDedupCacheForTests());

  // A stub whose execute() would surface DISTINCT content — so if a dedup
  // miss let it run, the assertion on the cached content below would fail.
  // On a genuine hit the phase halts BEFORE sandbox and this never runs.
  function freshTool(name: string): ToolDefinition {
    return {
      name,
      description: "",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      concurrencySafe: true,
      execute: async (): Promise<ToolResult> => ({ content: "FRESH-EXECUTION-SHOULD-NOT-APPEAR", isError: false }),
    } as unknown as ToolDefinition;
  }

  it("a dedup hit returns one tool message and one tool_end, annotated as deduplicated", async () => {
    const toolMap = new Map<string, ToolDefinition>([
      ["fetch_stub", freshTool("fetch_stub")],
    ]);
    const session = "td4-dedup-session";
    const events: ServerEvent[] = [];
    const onEvent = (e: ServerEvent) => { events.push(e); };
    const args = JSON.stringify({ q: "same" });

    // Seed the dedup cache directly so this call is a genuine within-turn
    // repeat. (Exercising the hit path in isolation — the record path that
    // would populate this in production is a separate concern.)
    dedupRecord(session, "fetch_stub", args, {
      msgs: [],
      allowed: true,
      result: { content: "cached-payload-42", isError: false },
      resultContent: "cached-payload-42",
    });

    const msgs = await executeToolCalls(
      [{ id: "call-2", name: "fetch_stub", arguments: args }],
      toolMap, undefined as never, undefined, undefined, undefined, undefined, session, onEvent,
      undefined, undefined, undefined, undefined, "local",
    );

    // Exactly ONE tool message for call-2 — not the terminate+audit pair that
    // the pre-fix hit path produced (two msgs + two tool_end under one id).
    const toolMsgs = msgs.filter(
      (m) => m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === "call-2",
    );
    expect(toolMsgs).toHaveLength(1);
    expect(msgs).toHaveLength(1);
    // The reused CACHED result (not a fresh execution) + the dedup annotation.
    expect(String(toolMsgs[0].content)).toContain("cached-payload-42");
    expect(String(toolMsgs[0].content)).toContain("deduplicated");
    expect(String(toolMsgs[0].content)).not.toContain("FRESH-EXECUTION");

    // Exactly ONE tool_end event for call-2.
    const ends = events.filter(
      (e) => e.type === "tool_end" && (e as { toolCallId?: string }).toolCallId === "call-2",
    );
    expect(ends).toHaveLength(1);
  });
});

// TD-7: dispatchSingleToolCall hardcoded { isError: false, status: "ok" },
// so blocked/errored calls reported silent success to adopters of the
// unified entry. It must recover the real status from the rendered header
// (parseStatusHeader), like the canonical dispatcher does.
describe("dispatchSingleToolCall reports the real envelope status (TD-7)", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));
  beforeEach(() => _clearDedupCacheForTests());

  function resultTool(name: string, result: ToolResult): ToolDefinition {
    return {
      name,
      description: "",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      concurrencySafe: true,
      execute: async (): Promise<ToolResult> => result,
    } as unknown as ToolDefinition;
  }

  it("a blocked tool result surfaces as status 'blocked' / isError true", async () => {
    const toolMap = new Map<string, ToolDefinition>([
      ["deny_stub", resultTool("deny_stub", { content: "denied by gate", isError: true, status: "blocked" })],
    ]);
    const r = await dispatchSingleToolCall(
      { id: "x1", name: "deny_stub", args: {} },
      { toolMap, security: undefined as never, callContext: "api" },
    );
    expect(r.status).toBe("blocked");
    expect(r.isError).toBe(true);
  });

  // Seam: a declined envelope rendered by renderToolResultForModel, parsed
  // back at the dispatch boundary (parseStatusHeader) — must land as
  // error-not-ok while keeping its distinct 'declined' status.
  it("a declined tool result surfaces as status 'declined' / isError true", async () => {
    const toolMap = new Map<string, ToolDefinition>([
      ["decline_stub", resultTool("decline_stub", { content: "DECLINED by user: decline_stub. Do not retry the same call — adjust your approach or ask the user.", isError: true, status: "declined" })],
    ]);
    const r = await dispatchSingleToolCall(
      { id: "x1d", name: "decline_stub", args: {} },
      { toolMap, security: undefined as never, callContext: "api" },
    );
    expect(r.status).toBe("declined");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("[declined");
  });

  it("an errored tool result surfaces as status 'error' / isError true", async () => {
    const toolMap = new Map<string, ToolDefinition>([
      ["err_stub", resultTool("err_stub", { content: "boom", isError: true, status: "error" })],
    ]);
    const r = await dispatchSingleToolCall(
      { id: "x2", name: "err_stub", args: {} },
      { toolMap, security: undefined as never, callContext: "api" },
    );
    expect(r.status).toBe("error");
    expect(r.isError).toBe(true);
  });

  it("a successful tool result still reports ok / isError false", async () => {
    const toolMap = new Map<string, ToolDefinition>([
      ["ok_stub", resultTool("ok_stub", { content: "fine", isError: false })],
    ]);
    const r = await dispatchSingleToolCall(
      { id: "x3", name: "ok_stub", args: {} },
      { toolMap, security: undefined as never, callContext: "api" },
    );
    expect(r.status).toBe("ok");
    expect(r.isError).toBe(false);
  });
});

describe("canonical unattended shell capability gate", () => {
  const SHELL_BACKENDS = ["bash", "shell", "ari_shell", "process_start", "process_restart", "app_serve_backend", "app_serve_frontend"];
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousMode: string | undefined;
  let seq = 0;

  beforeAll(() => {
    setAriRequired(false);
    previousDataDir = process.env.LAX_DATA_DIR;
    previousMode = process.env.LAX_SANDBOX;
    dataDir = mkdtempSync(join(tmpdir(), "lax-shell-pipeline-"));
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "host";
  });

  afterAll(() => {
    setAriRequired(true);
    if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = previousDataDir;
    if (previousMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = previousMode;
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => setUnconfinedHostAcknowledgement(false));

  async function dispatch(name: string, sessionId: string, callContext: "api" | "delegated" | "cron", acknowledged: boolean) {
    if (acknowledged) setUnconfinedHostAcknowledgement(true);
    sessionId = `${sessionId}-${seq++}`;
    setSessionProfile(sessionId, "Power");
    const execute = vi.fn(async (): Promise<ToolResult> => ({ content: `executed:${name}` }));
    const tool = {
      name,
      description: "shell gate test",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      execute,
    } as unknown as ToolDefinition;
    try {
      const messages = await executeToolCalls(
        [{ id: `call-${seq}`, name, arguments: JSON.stringify({ command: "echo ok" }) }],
        new Map([[name, tool]]),
        undefined as never,
        undefined,
        undefined,
        undefined,
        undefined,
        sessionId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        callContext,
      );
      return { execute, content: String(messages[0]?.content ?? "") };
    } finally {
      clearSessionProfile(sessionId);
    }
  }

  const ORIGINS = [
    { label: "delegated agent", sessionId: "agent-shell-gate", callContext: "delegated" as const },
    { label: "worker session", sessionId: "worker-app-forged", callContext: "delegated" as const },
    { label: "API with chat-style session", sessionId: "chat-forged-mcp", callContext: "api" as const },
  ];

  for (const origin of ORIGINS) {
    it.each(SHELL_BACKENDS)(`blocks %s on an unacknowledged unconfined ${origin.label}`, async (name) => {
      const result = await dispatch(name, origin.sessionId, origin.callContext, false);
      expect(result.execute).not.toHaveBeenCalled();
      expect(result.content).toMatch(/effective mode is "host"/i);
    });

    it.each(SHELL_BACKENDS)(`allows %s on an acknowledged unconfined ${origin.label}`, async (name) => {
      const result = await dispatch(name, origin.sessionId, origin.callContext, true);
      expect(result.execute).toHaveBeenCalledOnce();
      expect(result.content).toContain(`executed:${name}`);
    });
  }

  it("defaults omitted origin metadata to API even for a chat-style session id", async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ content: "executed:shell" }));
    const tool = { name: "shell", description: "", parameters: { type: "object", properties: {} }, execute } as unknown as ToolDefinition;
    const messages = await executeToolCalls(
      [{ id: "default-api", name: "shell", arguments: JSON.stringify({ command: "echo ok" }) }],
      new Map([[tool.name, tool]]), undefined as never, undefined, undefined, undefined, undefined, "chat-style-forged",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(String(messages[0]?.content)).toMatch(/effective mode is "host"/i);
  });

  it.each(SHELL_BACKENDS)("categorically blocks %s in cron even when host execution is acknowledged", async (name) => {
    const result = await dispatch(name, "chat-looking-cron", "cron", true);
    expect(result.execute).not.toHaveBeenCalled();
    expect(result.content).toMatch(/categorically disabled for cron/i);
  });
});
