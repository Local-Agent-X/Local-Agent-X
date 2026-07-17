import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolCalls } from "../tool-execution/execute-tool.js";
import { _clearDedupCacheForTests } from "../tool-execution/dedup-cache.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { getApprovalManager } from "../approval-manager.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { clearExternalIngestion, recordExternalIngestion } from "../data-lineage/external.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import { MemoryIndex } from "./index.js";
import { createFactsTools } from "./tools/facts.js";

// Pipeline-fidelity contract: a memory write that passes the promotion gate
// MUST end up in the database, driven through executeToolCalls — the exact
// entry the chat runner dispatches through — not tool.execute() directly.
// The Jul 2026 outage (retry-call arg cloning dropping the capability stamp)
// was invisible to every tool-level test precisely because they skipped the
// dispatch hops between gate and sink. Do not "simplify" these tests to call
// the tool directly; the hops are the subject under test.

let dir: string;
let memory: MemoryIndex;
let toolMap: Map<string, ToolDefinition>;
let seq = 0;
const sessions = new Set<string>();

beforeAll(() => setAriRequired(false));
afterAll(() => setAriRequired(true));

beforeEach(() => {
  _clearDedupCacheForTests();
  dir = mkdtempSync(join(tmpdir(), "memory-pipeline-"));
  memory = new MemoryIndex(dir, { minScore: -1 });
  toolMap = new Map(createFactsTools(memory).map((tool) => [tool.name, tool as unknown as ToolDefinition]));
});

afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
  for (const session of sessions) {
    getApprovalManager().clearSession(session);
    clearSessionProfile(session);
    clearExternalIngestion(session);
  }
  sessions.clear();
});

async function dispatchRemember(opts: {
  content: string;
  userMessage: string;
  taintSession?: boolean;
  approve?: boolean;
}) {
  const sessionId = `pipeline-${++seq}`;
  sessions.add(sessionId);
  setSessionProfile(sessionId, "Power");
  if (opts.taintSession) recordExternalIngestion(sessionId);
  const events: ServerEvent[] = [];
  const onEvent = (event: ServerEvent) => {
    events.push(event);
    if (opts.approve !== undefined && event.type === "approval_requested") {
      getApprovalManager().resolveApproval(
        (event as ServerEvent & { approvalId: string }).approvalId,
        opts.approve,
      );
    }
  };
  const msgs = await executeToolCalls(
    [{ id: `tc-pipeline-${seq}`, name: "remember", arguments: JSON.stringify({ content: opts.content }) }],
    toolMap,
    undefined as never,
    undefined, undefined, undefined, undefined,
    sessionId,
    onEvent,
    undefined,
    [{ role: "user", content: opts.userMessage }],
    undefined, undefined,
    "local",
  );
  return { events, msgs };
}

function toolMessageText(msgs: Awaited<ReturnType<typeof executeToolCalls>>): string {
  const toolMsg = msgs.find((message) => message.role === "tool");
  return String(toolMsg?.content ?? "");
}

describe("memory writes through the full canonical dispatch pipeline", () => {
  it("clean session: silent save is recallable from the database", async () => {
    const { events, msgs } = await dispatchRemember({
      content: "The user named the assistant Nova",
      userMessage: "From now on I'll call you Nova.",
    });
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
    expect(toolMessageText(msgs)).toMatch(/^Remembered/);
    const facts = memory.recallByKind("observation");
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toContain("Nova");
  });

  it("tainted session: save is silent (no card) and persists with the tainted source label", async () => {
    const { events, msgs } = await dispatchRemember({
      content: "The user named the assistant Nova",
      userMessage: "From now on I'll call you Nova.",
      taintSession: true,
    });
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
    expect(toolMessageText(msgs)).toMatch(/^Remembered/);
    const facts = memory.recallByKind("observation");
    expect(facts).toHaveLength(1);
    expect(facts[0].sourceFile).toBe("agent-tool:tainted-external-inference");
  });

  it("tainted session over quota: dispatch returns BLOCKED and persists nothing", async () => {
    const sessionId = `pipeline-${seq + 1}`; // the id dispatchRemember will mint next
    const { stampTaintedModelPromotion, TAINTED_PROMOTION_QUOTA, clearTaintedPromotionQuota } =
      await import("./promotion-gate.js");
    for (let i = 0; i < TAINTED_PROMOTION_QUOTA; i++) {
      stampTaintedModelPromotion({}, {
        content: `junk ${i}`, target: "memory:retain", source: "model-tool:remember",
        sessionId, provenance: "model-declared:inference", confidence: 0.6, origin: "assistant",
      });
    }
    try {
      const { events, msgs } = await dispatchRemember({
        content: "The user named the assistant Nova",
        userMessage: "From now on I'll call you Nova.",
        taintSession: true,
      });
      expect(events.some((event) => event.type === "approval_requested")).toBe(false);
      expect(toolMessageText(msgs)).toMatch(/tainted-memory write quota/);
      expect(memory.recallByKind("observation")).toHaveLength(0);
    } finally {
      clearTaintedPromotionQuota(sessionId);
    }
  });
});
