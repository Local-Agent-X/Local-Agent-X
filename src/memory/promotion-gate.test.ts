import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApprovalManager } from "../approval-manager.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { requireApprovalPhase } from "../tool-execution/require-approval.js";
import type { ToolCallContext } from "../tool-execution/context.js";
import type { ServerEvent } from "../types.js";
import { MemoryIndex } from "./index.js";
import { createFactsTools } from "./tools/facts.js";
import { createInternalMemoryContext } from "./promotion-gate.js";

let dir: string;
let memory: MemoryIndex;
let seq = 0;
const sessions = new Set<string>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-promotion-"));
  memory = new MemoryIndex(dir, { minScore: -1 });
});

afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
  for (const session of sessions) {
    getApprovalManager().clearSession(session);
    clearSessionProfile(session);
  }
  sessions.clear();
});

async function prepareRemember(opts: {
  content: string;
  userMessage: string;
  provenance?: string;
  confidence?: number;
  approve?: boolean;
  toolResult?: string;
}) {
  const sessionId = `promotion-${++seq}`;
  sessions.add(sessionId);
  setSessionProfile(sessionId, "Power");
  const args: Record<string, unknown> = {
    content: opts.content,
    provenance: opts.provenance ?? "inference",
    confidence: opts.confidence ?? 0.6,
    _sessionId: sessionId,
  };
  const events: ServerEvent[] = [];
  const ctx = {
    tc: { id: `tc-${seq}`, name: "remember", arguments: JSON.stringify(args) },
    sessionId,
    callContext: "local",
    args,
    priorMessages: [
      { role: "user", content: opts.userMessage },
      ...(opts.toolResult ? [{ role: "tool", content: opts.toolResult }] : []),
    ],
    onEvent: (event: ServerEvent) => {
      events.push(event);
      if (opts.approve && event.type === "approval_requested") {
        getApprovalManager().resolveApproval(event.approvalId, true);
      }
    },
    approvalContext: "",
    riskLevel: "low",
    allowed: true,
    msgs: [],
  } as unknown as ToolCallContext;
  return { args, events, outcome: await requireApprovalPhase(ctx) };
}

function rememberTool() {
  return createFactsTools(memory).find((tool) => tool.name === "remember")!;
}

describe("memory promotion through the canonical tool pipeline", () => {
  it("does not prompt for explicit current-turn profile and project requests", async () => {
    const cases = [
      {
        name: "memory_update_profile",
        args: { file: "user", action: "append", content: "User prefers concise answers" },
        user: "Update my profile to say I prefer concise answers.",
      },
      {
        name: "project_brief_update",
        args: { project: "Initech", content: "Goal is one million dollars" },
        user: "Update the project brief: the goal is one million dollars.",
      },
    ];
    for (const item of cases) {
      const sessionId = `promotion-${++seq}`;
      sessions.add(sessionId);
      setSessionProfile(sessionId, "Power");
      const events: ServerEvent[] = [];
      const args = { ...item.args, _sessionId: sessionId };
      const ctx = {
        tc: { id: `tc-${seq}`, name: item.name, arguments: JSON.stringify(args) },
        sessionId, callContext: "local", args,
        priorMessages: [{ role: "user", content: item.user }],
        onEvent: (event: ServerEvent) => events.push(event),
        approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
      } as unknown as ToolCallContext;
      expect((await requireApprovalPhase(ctx)).kind).toBe("continue");
      expect(events.some((event) => event.type === "approval_requested")).toBe(false);
    }
  });

  it("uses exact current-user-turn evidence without prompting", async () => {
    const prepared = await prepareRemember({
      content: "User prefers concise answers",
      userMessage: "Please remember that I prefer concise answers.",
      provenance: "user_statement",
      confidence: 1,
    });

    expect(prepared.outcome.kind).toBe("continue");
    expect(prepared.events.some((event) => event.type === "approval_requested")).toBe(false);
    const result = await rememberTool().execute(prepared.args);
    expect(result.isError, result.content).toBeUndefined();
    expect(memory.recallByKind("observation")).toHaveLength(1);
  });

  it("prompts for external content and consumes the exact approval once", async () => {
    const prepared = await prepareRemember({
      content: "The remote service is permanently healthy",
      userMessage: '<<<EXTERNAL_UNTRUSTED_CONTENT id="x">>>service healthy<<<END_EXTERNAL_UNTRUSTED_CONTENT id="x">>>',
      provenance: "user_statement",
      confidence: 1,
      approve: true,
    });

    expect(prepared.events.filter((event) => event.type === "approval_requested")).toHaveLength(1);
    const originalContent = String(prepared.args.content);
    prepared.args.content = "Different content";
    expect((await rememberTool().execute(prepared.args)).isError).toBe(true);
    prepared.args.content = originalContent;
    const originalSession = String(prepared.args._sessionId);
    prepared.args._sessionId = `${originalSession}-other`;
    expect((await rememberTool().execute(prepared.args)).isError).toBe(true);
    prepared.args._sessionId = originalSession;
    prepared.args.query = "anything";
    const update = createFactsTools(memory).find((tool) => tool.name === "update_fact")!;
    expect((await update.execute(prepared.args)).isError).toBe(true);
    delete prepared.args.query;
    const first = await rememberTool().execute(prepared.args);
    expect(first.isError, first.content).toBeUndefined();
    const replay = await rememberTool().execute(prepared.args);
    expect(replay.isError).toBe(true);
    expect(replay.content).toMatch(/already been consumed/);
  });

  it("prompts when a tool result occurred after an explicit user memory request", async () => {
    const prepared = await prepareRemember({
      content: "The service is healthy",
      userMessage: "Remember the service health.",
      toolResult: "The service is healthy",
      provenance: "tool_observation",
      approve: true,
    });
    expect(prepared.events.filter((event) => event.type === "approval_requested")).toHaveLength(1);
    const result = await rememberTool().execute(prepared.args);
    expect(result.isError, result.content).toBeUndefined();
  });

  it("binds approval to provenance, confidence, source, and session", async () => {
    const approved = await prepareRemember({
      content: "The remote service is healthy",
      userMessage: "unknown observation",
      provenance: "tool_observation",
      confidence: 0.6,
      approve: true,
    });
    approved.args.provenance = "user_statement";
    approved.args.confidence = 1;
    const result = await rememberTool().execute(approved.args);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/provenance\/confidence|capability required/);
  });

  it("raw durable primitives deny callers without a capability", async () => {
    expect(() => memory.retain("- S(c=0.8) bypass", "unknown")).toThrow(/capability required/);
    await expect(memory.retainSmart("- S(c=0.8) bypass", "unknown")).rejects.toThrow(/capability required/);
    expect(() => memory.rememberFact("bypass")).toThrow(/capability required/);
    memory.rememberFact("existing fact", {
      promotion: createInternalMemoryContext("existing fact", "memory:retain", "test"),
    });
    expect(() => memory.updateFact("existing fact", "bypass")).toThrow(/capability required/);
  });
});
