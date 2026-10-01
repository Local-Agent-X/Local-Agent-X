// The false-alarm class, as a sequence. A session carries a tainted read; the
// run then makes several outbound calls in a row through the chat lane's own
// dispatcher and the real arikernel preset. Each call is judged on its own
// bytes: clean ones proceed however many came before, the one that carries the
// tainted bytes is refused, and that refusal does not disarm the calls after
// it. Every earlier test made ONE call, which is how the kernel's run-level
// label merge (it re-added the run's taint to each later call, overruling the
// clean verdict) and its read-then-egress sequence rule went unseen.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTools } from "../canonical-loop/public/test-surface.js";
import { makeChatToolDispatcher, registerToolDispatcherForOp, unregisterToolDispatcherForOp, unregisterToolsForOp } from "../canonical-loop/index.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import { readKernelQuarantine } from "../ari-kernel/quarantine.js";
import { clearSessionTaint, recordSensitiveRead } from "../data-lineage/index.js";
import type { ToolDefinition, ToolResult } from "../types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const LEAKED = "the quarterly vendor ledger lists harbor-ninety as the settlement account";
const opIds: string[] = [];

function fake(name: string): ToolDefinition {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    execute: async (): Promise<ToolResult> => ({ content: `${name} ran`, status: "ok" }),
  } as unknown as ToolDefinition;
}

function wire(opId: string): void {
  registerToolDispatcherForOp(opId, makeChatToolDispatcher({
    tools: ["browser", "http_request", "email_send", "bash"].map(fake),
    security: undefined as never,
    sessionId: `s-${opId}`,
    callContext: "local",
    opId,
    onEvent: () => {},
  }));
}

async function call(opId: string, turn: number, tool: string, args: Record<string, unknown>): Promise<string> {
  const out = await dispatchTools(opId, turn, [{ toolCallId: `${tool}-${turn}`, tool, args }]);
  return out.toolSummary[0].resultStatus;
}

describe("outbound calls after a tainted read are judged one by one, on their bytes", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeAll(async () => {
    process.env.LAX_AUDIT_KEY = "test-outbound-sequence-key-0123456789";
    dir = mkdtempSync(join(tmpdir(), "lax-outseq-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
  });
  afterAll(() => {
    stopAriKernel();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY; else process.env.LAX_AUDIT_KEY = prevKey;
    for (const id of opIds) {
      const d = join(OPS_BASE, id);
      if (existsSync(d)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });
  afterEach(() => { for (const id of opIds) { unregisterToolDispatcherForOp(id); unregisterToolsForOp(id); } });

  it("clean writes proceed in a row, the leaking one is refused, and the run is not disarmed by it", async () => {
    const opId = `op_outseq_${process.pid}`;
    opIds.push(opId);
    clearSessionTaint(`s-${opId}`);
    recordSensitiveRead(`s-${opId}`, "sensitive_file", "proj/.env", LEAKED);
    wire(opId);
    try {
      const fill = { action: "fill", ref: 4, value: "Gmail Cleanup Tool for the marketing team" };
      const post = { url: "https://api.example.com/v1/projects", method: "POST", body: JSON.stringify({ name: "marketing cleanup project" }) };
      const mail = { to: "pat@example.com", subject: "Cleanup tool is set up", body: "The cleanup tool is configured for the marketing team account." };

      // Several clean writes in a row: none carries the tainted bytes.
      expect(await call(opId, 1, "browser", fill)).toBe("ok");
      expect(await call(opId, 2, "http_request", post)).toBe("ok");
      expect(await call(opId, 3, "email_send", mail)).toBe("ok");
      expect(await call(opId, 4, "browser", fill)).toBe("ok");

      // The one that carries the tainted bytes is refused, on every channel.
      expect(await call(opId, 5, "http_request", { ...post, body: JSON.stringify({ note: LEAKED }) })).toBe("blocked");
      expect(await call(opId, 6, "email_send", { ...mail, body: `Forwarding this: ${LEAKED}` })).toBe("blocked");
      expect(await call(opId, 7, "browser", { ...fill, value: LEAKED })).toBe("blocked");

      // … and those refusals do not disarm the clean calls after them.
      expect(await call(opId, 8, "browser", fill)).toBe("ok");
      expect(await call(opId, 9, "http_request", post)).toBe("ok");
      expect(await call(opId, 10, "bash", { command: "git status" })).toBe("ok");
      expect(readKernelQuarantine(opId, false)).toBeNull();
    } finally { clearSessionTaint(`s-${opId}`); }
  });
});
