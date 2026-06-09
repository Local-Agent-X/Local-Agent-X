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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { executeToolCalls } from "./execute-tool.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { clearSessionTaint, getTaintSummary } from "../data-lineage.js";
import type { ToolDefinition, ToolResult } from "../types.js";

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
    );
    // Sequential: read's enter+exit precede web_search's enter entirely.
    expect(events).toEqual(["enter:read", "exit:read", "enter:web_search", "exit:web_search"]);
  });

  it("the sensitive read taints BEFORE web_search's egress gate runs → web_search is blocked", async () => {
    // The round-4 repro: [read('<sensitive>'), web_search(...)]. The read of a
    // sensitive path sets the taint floor (pre-execute, from args); because the
    // batcher keeps web_search in a later batch, web_search's real dataLineageGate
    // sees the floor and blocks. The web_search stub's execute must therefore
    // NEVER run.
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
    );

    // The read tainted the session (floor set from args, pre-execute).
    expect(getTaintSummary(session).count).toBeGreaterThan(0);

    // web_search's execute never ran — its egress gate blocked it first.
    expect(events).not.toContain("enter:web_search");

    // The web_search tool message is the data-lineage block.
    const webMsg = msgs.find((m) => (m as { tool_call_id?: string }).tool_call_id === "2");
    expect(String(webMsg?.content)).toMatch(/BLOCKED by data lineage|tainted/i);

    clearSessionTaint(session);
  });
});
