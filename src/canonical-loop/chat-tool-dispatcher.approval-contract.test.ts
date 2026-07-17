import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { setAriRequired } from "../ari-kernel/state.js";
import { getApprovalManager } from "../approval-manager.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { workspacePath as configuredWorkspacePath } from "../config.js";
import { SecurityLayer } from "../security/index.js";
import { ToolPolicy } from "../tool-policy/index.js";
import { DEFAULT_POLICY } from "../tool-policy/default-rules.js";
import type { Op } from "../ops/types.js";
import { writeOp, readOp } from "../ops/op-store.js";
import { opDir } from "../ops/event-log.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import {
  OP_EVENTS_FROM_BEGINNING,
  opEventsSince,
  opResolveApproval,
} from "./index.js";
import { makeChatToolDispatcher } from "./chat-tool-dispatcher.js";

let sequence = 0;
const sessions: string[] = [];
const opIds: string[] = [];

function uniqueId(label: string): string {
  sequence += 1;
  return `${label}-${process.pid}-${sequence}`;
}

function createOp(label: string): string {
  const id = uniqueId(label);
  const op: Op = {
    id,
    type: "chat_turn",
    task: "dispatcher approval contract",
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [1] },
    ownerId: "local-user",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
  writeOp(op);
  opIds.push(id);
  return id;
}

function pinSession(profile: Parameters<typeof setSessionProfile>[1]): string {
  const sessionId = uniqueId("dispatcher-approval-session");
  setSessionProfile(sessionId, profile);
  sessions.push(sessionId);
  return sessionId;
}

function mutationTool(executions: string[]): ToolDefinition {
  return {
    name: "write",
    description: "Deterministic mutation used to verify dispatcher gating.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        value: { type: "string" },
      },
      required: ["path", "value"],
    },
    execute: async (args) => {
      const value = String(args.value);
      executions.push(value);
      return { content: `mutation-executed:${value}`, status: "ok" };
    },
  };
}

function approvalEvents(events: ServerEvent[]): ServerEvent[] {
  return events.filter((event) =>
    event.type === "approval_requested" || event.type === "approval_resolved",
  );
}

beforeAll(() => setAriRequired(false));

afterEach(() => {
  for (const sessionId of sessions.splice(0)) {
    getApprovalManager().clearSession(sessionId);
    clearSessionProfile(sessionId);
  }
  for (const opId of opIds.splice(0)) {
    rmSync(opDir(opId), { recursive: true, force: true });
  }
});

afterAll(() => setAriRequired(true));

describe("canonical dispatcher approval contract", () => {
  it("keeps an Autonomous delegated workspace mutation approval-free", async () => {
    const sessionId = pinSession("Autonomous");
    const opId = createOp("op-autonomous-write");
    const executions: string[] = [];
    const events: ServerEvent[] = [];
    const dispatcher = makeChatToolDispatcher({
      tools: [mutationTool(executions)],
      security: new SecurityLayer(configuredWorkspacePath(), "unrestricted"),
      toolPolicy: new ToolPolicy(DEFAULT_POLICY),
      sessionId,
      callContext: "delegated",
      opId,
      onEvent: (event) => events.push(event),
    });

    const result = await dispatcher.dispatch({
      toolCallId: "tc-autonomous-write",
      tool: "write",
      args: { path: configuredWorkspacePath("autonomous.txt"), value: "autonomous" },
    });

    expect(result.status).toBe("ok");
    expect(String(result.result)).toContain("mutation-executed:autonomous");
    expect(executions).toEqual(["autonomous"]);
    expect(approvalEvents(events)).toEqual([]);
    expect(events.filter((event) => event.type === "tool_end")).toHaveLength(1);
    expect(readOp(opId)?.canonical?.pendingApproval).toBeUndefined();
  });

  it("routes a policy-confirmed mutation through one durable approval and does not leak the grant", async () => {
    const sessionId = pinSession("Power");
    const opId = createOp("op-policy-confirm-write");
    const executions: string[] = [];
    const events: ServerEvent[] = [];
    const pendingSnapshots: Array<string | null> = [];
    const deliveries: Array<ReturnType<typeof opResolveApproval>> = [];
    let requestCount = 0;

    const dispatcher = makeChatToolDispatcher({
      tools: [mutationTool(executions)],
      security: new SecurityLayer(configuredWorkspacePath(), "unrestricted"),
      toolPolicy: new ToolPolicy({
        defaultDecision: "deny",
        rules: [{
          id: "confirm-contract-write",
          tool: "write",
          decision: "confirm",
          reason: "Contract mutation requires review",
        }],
      }),
      sessionId,
      callContext: "local",
      opId,
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "approval_requested") return;
        requestCount += 1;
        const approve = requestCount === 1;
        queueMicrotask(() => {
          pendingSnapshots.push(
            readOp(opId)?.canonical?.pendingApproval?.approvalId ?? null,
          );
          deliveries.push(opResolveApproval(opId, event.approvalId, approve));
        });
      },
    });

    const approved = await dispatcher.dispatch({
      toolCallId: "tc-confirmed-write-1",
      tool: "write",
      args: { path: configuredWorkspacePath("approved.txt"), value: "approved" },
    });
    const rejected = await dispatcher.dispatch({
      toolCallId: "tc-confirmed-write-2",
      tool: "write",
      args: { path: configuredWorkspacePath("rejected.txt"), value: "rejected" },
    });

    expect(approved.status).toBe("ok");
    expect(String(approved.result)).toContain("mutation-executed:approved");
    expect(rejected.status).toBe("declined");
    expect(executions).toEqual(["approved"]);
    expect(requestCount).toBe(2);
    expect(pendingSnapshots).toHaveLength(2);
    expect(pendingSnapshots.every((approvalId) => approvalId !== null)).toBe(true);
    expect(deliveries).toEqual([
      { ok: true, delivery: "delivered" },
      { ok: true, delivery: "delivered" },
    ]);

    expect(events.filter((event) => event.type === "approval_requested")).toHaveLength(2);
    expect(events.filter((event) => event.type === "approval_resolved")).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool_end")).toHaveLength(2);
    expect(readOp(opId)?.canonical?.pendingApproval).toBeNull();

    const durable = opEventsSince(opId, OP_EVENTS_FROM_BEGINNING);
    expect(durable.ok).toBe(true);
    if (!durable.ok) throw new Error(`unable to read durable events: ${durable.code}`);
    expect(durable.events.map((event) => event.type)).toEqual([
      "approval_requested",
      "approval_resolved",
      "approval_requested",
      "approval_resolved",
    ]);
  });
});
