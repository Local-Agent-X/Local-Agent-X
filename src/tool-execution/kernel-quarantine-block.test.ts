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
// nothing else; no notice reached the user. That rule has since been deleted
// (a secrets response is masked and its values registered instead), so the
// sequence is pinned as allowed.
//
// Since 2026-10-01 LAX is the one adjudicator of data flow (the kernel runs
// with hostAdjudicatesDataFlow): a .env write followed by a POST that carries
// nothing from it is no longer refused by run rule sensitive_read_then_egress,
// and the naming/tracing assertions ride a genuine leak instead — a POST whose
// body carries bytes of a tainted read.
//
// 02:51:15 — a WRITE to scripts/set-unsub-secret.mjs counted as a sensitive
// read to the kernel's substring matcher; the next POST quarantined the turn
// and seven later shell calls were refused, each logged as status "ok" because
// the non-egress deny was rendered raw with no status header.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTools } from "../canonical-loop/public/test-surface.js";
import {
  makeChatToolDispatcher, registerToolDispatcherForOp, unregisterToolDispatcherForOp, unregisterToolsForOp,
  getBus, eventsChannel, readOpMessages, type CanonicalEvent,
} from "../canonical-loop/index.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import { readKernelQuarantine } from "../ari-kernel/quarantine.js";
import { clearSessionTaint, isSensitivePath, recordSensitiveRead } from "../data-lineage/index.js";
import type { ServerEvent, ToolBlockRecord, ToolDefinition, ToolResult } from "../types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const PROJECT = "kybhkldvgdezjrwnmmyr";
const SECRETS_URL = `https://api.supabase.com/v1/projects/${PROJECT}/secrets`;
const QUERY_URL = `https://api.supabase.com/v1/projects/${PROJECT}/database/query`;
const AUTH = { Authorization: "Bearer {{SUPABASE_FULL_ACCOUNT_TOKEN}}", "Content-Type": "application/json" };
// Bytes of a tainted read the agent then tries to send: long enough to be
// fingerprinted, plain words so it is judged on provenance, not secret shape.
const LEAKED = "the quarterly vendor ledger lists harbor-ninety as the settlement account";

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

  // 02:32:44 was a secrets GET followed by a POST the agent authored. That
  // sequence no longer quarantines: kernel rule 6 is gone, and what the GET
  // returned is masked and registered so the outbound scan refuses its values
  // anywhere (secrets-get-then-post-replay.test.ts drives it through the real
  // http tool). Here, through the chat dispatcher with fakes: allowed, clean.
  it("02:32:44 — a secrets GET followed by an authored POST is not a quarantine", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    const { ui, stop } = wire(opId, ["http_request"]);
    try {
      await dispatchTools(opId, 6, [{ toolCallId: "get-secrets", tool: "http_request", args: { url: SECRETS_URL, headers: AUTH, find: "EMAIL" } }]);
      const out = await dispatchTools(opId, 6, [{
        toolCallId: "post-query", tool: "http_request",
        args: { url: QUERY_URL, method: "POST", headers: AUTH, body: JSON.stringify({ query: "select to_regclass('public.email_opt_outs') as opt_outs" }) },
      }]);
      expect(out.toolSummary.map((s) => s.resultStatus)).toEqual(["ok"]);
      expect(toolEnd(ui, "post-query")?.status).toBe("ok");
      expect(readKernelQuarantine(opId, false)).toBeNull();
    } finally { stop(); }
  });

  it("a POST carrying bytes of a tainted read is refused, offers the declassify control, and is traced end to end", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    recordSensitiveRead(`s-${opId}`, "sensitive_file", "proj/.env", LEAKED);
    const { ui, log, stop } = wire(opId, ["http_request", "bash"]);
    try {
      const out = await dispatchTools(opId, 6, [{ toolCallId: "post-query", tool: "http_request", args: { url: QUERY_URL, method: "POST", headers: AUTH, body: JSON.stringify({ note: LEAKED }) } }]);

      expect(out.toolSummary.map((s) => s.resultStatus)).toEqual(["blocked"]);
      const end = toolEnd(ui, "post-query");
      expect(end?.status).toBe("blocked");
      const md = end?.metadata ?? {};
      // The kernel refused it on the labels LAX kept (the payload is not
      // clean), and data-lineage names the evidence: one aggregate, both layers.
      expect(md.layer).toBe("egress-aggregate");
      expect(md.layers).toEqual(expect.arrayContaining(["arikernel", "data-lineage"]));
      // The block is session taint the user can clear, so the control is offered.
      expect(md.clearable).toBe("declassify");

      // Durable: the op's event log carries the structured record …
      const [fin] = finished(log, "http_request").slice(-1);
      expect(fin.status).toBe("blocked");
      expect(fin.block?.clearable).toBe("declassify");
      expect(fin.block?.notice).toBe("declassify-card");
      // … and the tool_result row does too, without the request's header values.
      const row = out.toolMessages[0].content as { block?: ToolBlockRecord };
      expect(row.block?.clearable).toBe("declassify");
      expect(JSON.stringify(row.block)).not.toContain("SUPABASE_FULL_ACCOUNT_TOKEN");

      // Only that call was refused: the run is not restricted, and the next
      // call in the same op runs.
      expect(readKernelQuarantine(opId, false)).toBeNull();
      const after = await dispatchTools(opId, 7, [{ toolCallId: "sh", tool: "bash", args: { command: "echo ok" } }]);
      expect(after.toolSummary.map((s) => s.resultStatus)).toEqual(["ok"]);
    } finally { stop(); clearSessionTaint(`s-${opId}`); }
  });

  it("a run that keeps trying to send tainted bytes is restricted at the threshold; the cascade is a blocked call with a record, not an 'ok'", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    recordSensitiveRead(`s-${opId}`, "sensitive_file", "proj/.env", LEAKED);
    const { ui, log, stop } = wire(opId, ["http_request", "bash"]);
    try {
      // Five refusals of the same leaking POST reach the kernel's default threshold.
      for (let i = 1; i <= 5; i++) {
        const out = await dispatchTools(opId, 1 + i, [{ toolCallId: `p${i}`, tool: "http_request", args: { url: QUERY_URL, method: "POST", headers: AUTH, body: JSON.stringify({ note: LEAKED }) } }]);
        expect(out.toolSummary[0].resultStatus).toBe("blocked");
      }
      expect(readKernelQuarantine(opId, false)?.trigger).toBe("restricted");
      const out = await dispatchTools(opId, 8, [{ toolCallId: "sh", tool: "bash", args: { command: "echo ok" } }]);

      // Before: raw two-line text, no header → parsed as "ok" everywhere downstream.
      expect(out.toolSummary[0].resultStatus).toBe("blocked");
      const [fin] = finished(log, "bash");
      expect(fin.status).toBe("blocked");
      expect(fin.block?.quarantine?.trigger).toBe("restricted");
      expect(fin.block?.quarantine?.restrictedAt).toMatch(/^\d{4}-/);
      const end = toolEnd(ui, "sh");
      expect(end?.status).toBe("blocked");
      expect(end?.metadata?.trigger).toBe("restricted");
      expect(end?.metadata?.clearable).toBeUndefined();
      expect(String(end?.metadata?.recovery)).toMatch(/restricted mode since/);
      // The restriction is the op's: another op's scope is clean.
      expect(readKernelQuarantine(freshOpId(), false)).toBeNull();
    } finally { stop(); clearSessionTaint(`s-${opId}`); }
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

  it("a write to a genuine secret path, then a POST carrying nothing from it, proceeds: the sequence alone is not a leak", async () => {
    const opId = freshOpId();
    clearSessionTaint(`s-${opId}`);
    const env = join(tmpdir(), "lax-kblock-ws", "proj", ".env");
    expect(isSensitivePath(env)).toBe(true);
    const { stop } = wire(opId, ["write", "http_request"]);
    try {
      await dispatchTools(opId, 2, [{ toolCallId: "w", tool: "write", args: { path: env, content: "X=1" } }]);
      const out = await dispatchTools(opId, 2, [{ toolCallId: "p", tool: "http_request", args: { url: QUERY_URL, method: "POST", headers: AUTH, body: "{}" } }]);
      expect(out.toolSummary[0].resultStatus).toBe("ok");
      expect(readKernelQuarantine(opId, false)).toBeNull();
    } finally { stop(); }
  });
});
