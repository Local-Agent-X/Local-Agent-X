import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getApprovalManager } from "../approval-manager.js";
import {
  getFirewallForTest,
  startAriKernel,
  stopAriKernel,
} from "../ari-kernel/index.js";
import {
  clearSessionTaint,
  recordSensitiveRead,
} from "../data-lineage/index.js";
import { SecurityLayer } from "../security/index.js";
import {
  stampedDefaultPolicy,
  ToolPolicy,
} from "../tool-policy/index.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import { executeToolCalls } from "./execute-tool.js";

describe("canonical tool pipeline audit contract", () => {
  let root: string;
  let sessionId: string;
  let operationId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "lax-pipeline-audit-"));
    sessionId = `pipeline-audit-session-${Date.now()}`;
    operationId = `pipeline-audit-op-${Date.now()}`;
    clearSessionTaint(sessionId);
    await startAriKernel(join(root, "audit.db"), "workspace-assistant", true);
  });

  afterEach(() => {
    getApprovalManager().clearSession(sessionId);
    clearSessionTaint(sessionId);
    stopAriKernel();
    rmSync(root, { recursive: true, force: true });
  });

  it("hash-chains an approval-free allow and policy denial with authoritative results", async () => {
    let readExecutions = 0;
    let requestExecutions = 0;
    const readPath = join(root, "classified-stub.txt");
    const readTool: ToolDefinition = {
      name: "read",
      description: "Classified test seam for the real dispatch pipeline",
      readOnly: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async () => {
        readExecutions++;
        return {
          content: "classified stub result",
          status: "ok",
          metadata: { source: "pipeline-audit-contract" },
        };
      },
    };
    const requestTool: ToolDefinition = {
      name: "http_request",
      description: "Must remain behind the real kernel policy",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string" },
          body: { type: "string" },
        },
        required: ["url"],
      },
      execute: async () => {
        requestExecutions++;
        return { content: "unexpected request execution" };
      },
    };
    const toolMap = new Map<string, ToolDefinition>([
      [readTool.name, readTool],
      [requestTool.name, requestTool],
    ]);
    const security = new SecurityLayer(root, "unrestricted");
    const toolPolicy = new ToolPolicy(stampedDefaultPolicy());
    const events: ServerEvent[] = [];

    const allowedMessages = await executeToolCalls(
      [{ id: "allowed-read", name: "read", arguments: JSON.stringify({ path: readPath }) }],
      toolMap,
      security,
      toolPolicy,
      undefined,
      undefined,
      undefined,
      sessionId,
      (event) => events.push(event),
      undefined,
      undefined,
      undefined,
      operationId,
      "local",
    );

    expect(readExecutions).toBe(1);
    expect(allowedMessages).toHaveLength(1);
    expect(allowedMessages[0]).toMatchObject({
      role: "tool",
      tool_call_id: "allowed-read",
    });
    expect(String(allowedMessages[0].content)).toContain("classified stub result");

    recordSensitiveRead(sessionId, "web", "https://untrusted.example/source");
    const deniedMessages = await executeToolCalls(
      [{
        id: "denied-request",
        name: "http_request",
        arguments: JSON.stringify({
          url: "https://example.com/audit-contract",
          method: "POST",
          body: "pipeline audit marker",
        }),
      }],
      toolMap,
      security,
      toolPolicy,
      undefined,
      undefined,
      undefined,
      sessionId,
      (event) => events.push(event),
      undefined,
      undefined,
      undefined,
      operationId,
      "local",
    );

    expect(requestExecutions).toBe(0);
    expect(deniedMessages).toHaveLength(1);
    expect(deniedMessages[0]).toMatchObject({
      role: "tool",
      tool_call_id: "denied-request",
    });
    expect(String(deniedMessages[0].content)).toMatch(/blocked/i);

    expect(events.filter((event) => event.type === "approval_requested")).toEqual([]);
    expect(events.filter((event) => event.type === "approval_resolved")).toEqual([]);
    expect(getApprovalManager().pendingCount()).toBe(0);

    const ends = events.filter((event) => event.type === "tool_end");
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({
      toolCallId: "allowed-read",
      allowed: true,
      status: "ok",
      metadata: { source: "pipeline-audit-contract" },
    });
    expect(ends[1]).toMatchObject({
      toolCallId: "denied-request",
      allowed: false,
      status: "blocked",
      metadata: {
        layer: "egress-aggregate",
        layers: expect.arrayContaining(["arikernel", "data-lineage"]),
      },
    });

    const firewall = getFirewallForTest(operationId);
    if (!firewall) throw new Error("operation-scoped Ari firewall was not created");
    const auditEvents = firewall.getEvents();
    expect(auditEvents).toHaveLength(3);
    expect(auditEvents[0]).toMatchObject({
      toolCall: {
        toolClass: "file",
        action: "read",
        parameters: expect.objectContaining({ path: readPath }),
      },
      decision: { verdict: "allow" },
    });
    expect(auditEvents[1]).toMatchObject({
      toolCall: {
        toolClass: "_system",
        action: "quarantine",
      },
      decision: {
        verdict: "deny",
        reason: expect.stringMatching(/untrusted web input.*http\.post/i),
      },
    });
    expect(auditEvents[2]).toMatchObject({
      toolCall: {
        toolClass: "http",
        action: "post",
        parameters: expect.objectContaining({ method: "POST" }),
      },
      decision: {
        verdict: "deny",
        reason: expect.stringMatching(/behavioral rule.*quarantined/i),
      },
    });
    expect(auditEvents[0].hash).toBeTruthy();
    expect(auditEvents[1].previousHash).toBe(auditEvents[0].hash);
    expect(auditEvents[1].hash).toBeTruthy();
    expect(auditEvents[1].hash).not.toBe(auditEvents[1].previousHash);
    expect(auditEvents[2].previousHash).toBe(auditEvents[1].hash);
    expect(auditEvents[2].hash).toBeTruthy();
    expect(auditEvents[2].hash).not.toBe(auditEvents[2].previousHash);

    const replay = firewall.replay();
    if (!replay) throw new Error("operation-scoped Ari replay was unavailable");
    expect(replay.integrity).toMatchObject({
      valid: true,
      sequenceValid: true,
      anchorValid: true,
    });
  });
});
