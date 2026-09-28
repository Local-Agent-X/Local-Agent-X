// The two kernel quarantines of 2026-09-27/28, replayed through the chat lane's
// own dispatcher (dispatchTools → makeChatToolDispatcher → executeToolCalls →
// the real arikernel workspace-assistant preset), capturing what reaches the
// UI (tool_end ServerEvents), the op's event log (tool_finished) and the
// tool_result row.
//
// 02:32:44 — a GET to a URL naming "secrets" followed by a POST tripped the
// kernel's secret_access_then_any_egress rule. The block reached the model as
// "evaluation error ... Run has been quarantined" with a recovery telling the
// user to click "Declassify & retry" — a control that clears session taint,
// of which there was none. The event log recorded status "blocked" and
// nothing else; no notice reached the user.
//
// 02:51:15 — a WRITE to scripts/set-unsub-secret.mjs counted as a sensitive
// read to the kernel's substring matcher; the next POST quarantined the turn
// and seven later shell calls were refused, each logged as status "ok" because
// the non-egress deny was rendered raw with no status header.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTools } from "../canonical-loop/turn-loop/dispatch-tools.js";
import { makeChatToolDispatcher } from "../canonical-loop/chat-tool-dispatcher.js";
import { registerToolDispatcherForOp, unregisterToolDispatcherForOp, unregisterToolsForOp } from "../canonical-loop/runtime.js";
import { getBus, eventsChannel } from "../canonical-loop/bus.js";
import { readOpMessages } from "../canonical-loop/store.js";
import type { CanonicalEvent } from "../canonical-loop/types.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import { readKernelQuarantine } from "../ari-kernel/quarantine.js";
import { clearSessionTaint, isSensitivePath } from "../data-lineage/index.js";
import type { ServerEvent, ToolBlockRecord, ToolDefinition, ToolResult } from "../types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const PROJECT = "kybhkldvgdezjrwnmmyr";
const SECRETS_URL = `https://api.supabase.com/v1/projects/${PROJECT}/secrets`;
const QUERY_URL = `https://api.supabase.com/v1/projects/${PROJECT}/database/query`;
const AUTH = { Authorization: "Bearer {{SUPABASE_FULL_ACCOUNT_TOKEN}}", "Content-Type": "application/json" };

let seq = 0;
const trackedOpIds: string[] = [];
function freshOpId(): string {
  const id = `op_kernel_block_test_${seq++}_${process.pid}`;
  trackedOpIds.push(id);
  return id;
}

/** A registered tool NAME with a fake body: the kernel class, capability class
 *  and policy entry all resolve from the name, so the gates under test run
 *  exactly as they do for the real tool; only the execution is stubbed. */
function fake(name: string): ToolDefinition {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    execute: async (): Promise<ToolResult> => ({ content: `${name} ran`, status: "ok" }),
  } as unknown as ToolDefinition;
}

function wire(opId: string, tools: string[]): { ui: ServerEvent[]; log: CanonicalEvent[]; stop: () => void } {
  const ui: ServerEvent[] = [];
  const log: CanonicalEvent[] = [];
  registerToolDispatcherForOp(opId, makeChatToolDispatcher({
    tools: tools.map(fake),
    security: undefined as never,
    sessionId: `s-${opId}`,
    callContext: "local",
    opId,
    onEvent: (e) => { ui.push(e); },
  }));
  const stop = getBus().subscribe(eventsChannel(opId), (msg) => { log.push(msg as CanonicalEvent); });
  return { ui, log, stop };
}

const toolEnd = (ui: ServerEvent[], id: string) =>
  ui.find((e) => e.type === "tool_end" && e.toolCallId === id) as Extract<ServerEvent, { type: "tool_end" }> | undefined;
const finished = (log: CanonicalEvent[], tool: string) =>
  log.filter((e) => e.type === "tool_finished" && (e.body as { tool: string }).tool === tool)
    .map((e) => e.body as { status: string; block?: ToolBlockRecord });

describe("a kernel quarantine, through the chat lane's dispatcher", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeAll(async () => {
    process.env.LAX_AUDIT_KEY = "test-kernel-block-key-0123456789abcdef";
    dir = mkdtempSync(join(tmpdir(), "lax-kblock-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
  });
  afterAll(() => {
    stopAriKernel();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
    for (const id of trackedOpIds) {
      const d = join(OPS_BASE, id);
      if (existsSync(d)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });
  afterEach(() => {
    for (const id of trackedOpIds) { unregisterToolDispatcherForOp(id); unregisterToolsForOp(id); }
  });

  it("02:32:44 — names the rule, offers no declassify (no taint to clear), and is traced end to end", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    const { ui, log, stop } = wire(opId, ["http_request"]);
    try {
      await dispatchTools(opId, 6, [{ toolCallId: "get-secrets", tool: "http_request", args: { url: SECRETS_URL, headers: AUTH, find: "EMAIL" } }]);
      const out = await dispatchTools(opId, 6, [{
        toolCallId: "post-query", tool: "http_request",
        args: { url: QUERY_URL, method: "POST", headers: AUTH, body: JSON.stringify({ query: "select to_regclass('public.email_opt_outs') as opt_outs" }) },
      }]);

      // The call is blocked, and the block names what actually fired.
      expect(out.toolSummary.map((s) => s.resultStatus)).toEqual(["blocked"]);
      const end = toolEnd(ui, "post-query");
      expect(end?.status).toBe("blocked");
      const md = end?.metadata ?? {};
      expect(md.layer === "arikernel" || (md.layers as string[] | undefined)?.includes("arikernel")).toBe(true);
      expect(md.rule).toBe("secret_access_then_any_egress");
      expect(md.trigger).toBe("behavioral_rule");
      expect(md.scope).toBe("operation");
      // Declassify clears session taint; none went into this verdict, so the
      // control is NOT offered and the model is not told to send the user to it.
      expect(md.clearable).toBeUndefined();
      expect(String(md.recovery)).not.toMatch(/Declassif/i);
      expect(String(md.recovery)).toMatch(/next user message starts clean/);
      expect(end?.result).toMatch(/secret_access_then_any_egress/);
      expect(end?.result).not.toMatch(/evaluation error/);

      // Durable: the op's event log carries the structured record …
      const [fin] = finished(log, "http_request").slice(-1);
      expect(fin.status).toBe("blocked");
      expect(fin.block?.notice).toBe("kernel-notice");
      expect(fin.block?.quarantine?.rule).toBe("secret_access_then_any_egress");
      expect(fin.block?.quarantine?.deniedActions).toBeGreaterThanOrEqual(1);
      expect(fin.block?.scope).toBe("operation");
      expect(fin.block?.clearable).toBeUndefined();
      // … and the tool_result row does too, without the request's header values.
      const row = out.toolMessages[0].content as { block?: ToolBlockRecord };
      expect(row.block?.quarantine?.rule).toBe("secret_access_then_any_egress");
      expect(JSON.stringify(row.block)).not.toContain("SUPABASE_FULL_ACCOUNT_TOKEN");

      // The quarantine is the op's: another op's scope is clean.
      expect(readKernelQuarantine(opId, false)).not.toBeNull();
      expect(readKernelQuarantine(freshOpId(), false)).toBeNull();
    } finally { stop(); }
  });

  it("the restricted-mode cascade is a blocked call with the same record, not an 'ok'", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    const { ui, log, stop } = wire(opId, ["http_request", "bash"]);
    try {
      await dispatchTools(opId, 1, [{ toolCallId: "g", tool: "http_request", args: { url: SECRETS_URL, headers: AUTH } }]);
      await dispatchTools(opId, 1, [{ toolCallId: "p", tool: "http_request", args: { url: QUERY_URL, method: "POST", headers: AUTH, body: "{}" } }]);
      const out = await dispatchTools(opId, 2, [{ toolCallId: "sh", tool: "bash", args: { command: "echo ok" } }]);

      // Before: raw two-line text, no header → parsed as "ok" everywhere downstream.
      expect(out.toolSummary[0].resultStatus).toBe("blocked");
      const [fin] = finished(log, "bash");
      expect(fin.status).toBe("blocked");
      expect(fin.block?.quarantine?.trigger).toBe("restricted");
      expect(fin.block?.quarantine?.rule).toBe("secret_access_then_any_egress");
      expect(fin.block?.quarantine?.restrictedAt).toMatch(/^\d{4}-/);
      const end = toolEnd(ui, "sh");
      expect(end?.status).toBe("blocked");
      expect(end?.metadata?.trigger).toBe("restricted");
      expect(end?.metadata?.clearable).toBeUndefined();
      expect(String(end?.metadata?.recovery)).toMatch(/restricted mode since/);
    } finally { stop(); }
  });

  it("02:51:15 — a write to a 'secret'-named script is not a sensitive read; the POST after it proceeds", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    const script = join(tmpdir(), "lax-kblock-ws", "scripts", "set-unsub-secret.mjs");
    // Sanity-anchor the canonical detector this rescue defers to.
    expect(isSensitivePath(script)).toBe(false);
    const { ui, stop } = wire(opId, ["write", "http_request"]);
    try {
      await dispatchTools(opId, 2, [{ toolCallId: "w", tool: "write", args: { path: script, content: "export {};" } }]);
      const out = await dispatchTools(opId, 2, [{ toolCallId: "p", tool: "http_request", args: { url: QUERY_URL, method: "POST", headers: AUTH, body: "{}" } }]);
      expect(out.toolSummary[0].resultStatus).toBe("ok");
      expect(toolEnd(ui, "p")?.status).toBe("ok");
      expect(readKernelQuarantine(opId, false)).toBeNull();
    } finally { stop(); }
  });

  it("… but a genuine secret path keeps the quarantine", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    const env = join(tmpdir(), "lax-kblock-ws", "proj", ".env");
    expect(isSensitivePath(env)).toBe(true);
    const { stop } = wire(opId, ["write", "http_request"]);
    try {
      await dispatchTools(opId, 2, [{ toolCallId: "w", tool: "write", args: { path: env, content: "X=1" } }]);
      const out = await dispatchTools(opId, 2, [{ toolCallId: "p", tool: "http_request", args: { url: QUERY_URL, method: "POST", headers: AUTH, body: "{}" } }]);
      expect(out.toolSummary[0].resultStatus).toBe("blocked");
      const row = out.toolMessages[0].content as { block?: ToolBlockRecord };
      expect(row.block?.quarantine?.rule).toBe("sensitive_read_then_egress");
    } finally { stop(); }
  });
});
