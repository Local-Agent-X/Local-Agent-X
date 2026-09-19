// A browser write is judged by what it CARRIES, not by what the session read.
//
// The kernel denies a tainted browser write on session state alone. Reading one
// email with token-shaped content therefore disarmed every later click/fill on
// every site for the rest of the run — a user setting up an OAuth app after
// asking about their inbox watched the agent go from working to narrating steps
// for them to perform by hand (2026-09-18). The block carried no evidence about
// the call it blocked.
//
// These drive the REAL arikernel workspace-assistant preset through the real
// enforcePolicyPhase. They fail on the pre-fix code, where a tainted session
// denied the benign fill in the first test.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { enforcePolicyPhase } from "./enforce-policy.js";
import { probeDataLineage } from "./egress-gates.js";
import { browserWriteIsTaintFree } from "./taint-scope.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage/index.js";
import type { ToolCallContext } from "./context.js";

// The tainted content: a webmail message the agent read while scoping the task.
// Recorded as "web" — the kernel label a content read actually produces
// (KERNEL_TAINT_SOURCE maps memory/sensitive_file/secret to "rag" instead).
const TAINTED_BODY = "Your verification code is 84213-QX and the recovery phrase is velvet-harbor-ninety.";

function makeCtx(args: Record<string, unknown>, sessionId: string): ToolCallContext {
  return {
    tc: { id: "1", name: "browser", arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: undefined as never,
    rbac: undefined as never,
    callerRole: undefined,
    toolPolicy: undefined as never,
    sessionId,
    callContext: undefined,
    args,
    msgs: [] as ChatCompletionMessageParam[],
    allowed: true,
    result: undefined,
  } as unknown as ToolCallContext;
}

describe("browser writes are scoped to the data flow, not the run", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeEach(async () => {
    process.env.LAX_AUDIT_KEY = "test-browser-taint-scope-key-0123456789";
    dir = mkdtempSync(join(tmpdir(), "lax-btaint-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
  });
  afterEach(() => {
    stopAriKernel();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("a fill carrying none of the tainted bytes is NOT denied at the kernel", async () => {
    const sid = "btaint-benign";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "mail.example/msg-1", TAINTED_BODY);

    // Long enough to be fingerprinted, and none of it comes from the email.
    const ctx = makeCtx({ action: "fill", ref: 4, value: "Gmail Cleanup Tool for the marketing team" }, sid);
    await enforcePolicyPhase(ctx);

    // The pre-fix code quarantined the run here.
    expect(ctx.result?.metadata?.layer).not.toBe("egress-aggregate");
    expect(String(ctx.result?.content ?? "")).not.toMatch(/quarantin/i);
  });

  it("a fill that DOES carry the tainted bytes is still blocked, and is clearable", async () => {
    const sid = "btaint-carries";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "mail.example/msg-1", TAINTED_BODY);

    const ctx = makeCtx({ action: "fill", ref: 4, value: TAINTED_BODY }, sid);
    await enforcePolicyPhase(ctx);

    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.status).toBe("blocked");
    // The user can authorize this one — it is a real flow, and the card renders.
    expect(ctx.result?.metadata?.clearable).toBe("declassify");
  });

  it("a passive browser action was never a write and stays unaffected", async () => {
    const sid = "btaint-nav";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "mail.example/msg-1", TAINTED_BODY);
    const ctx = makeCtx({ action: "navigate", url: "https://console.cloud.google.com" }, sid);
    await enforcePolicyPhase(ctx);
    expect(ctx.result?.metadata?.layer).not.toBe("egress-aggregate");
  });
});

describe("browserWriteIsTaintFree — the predicate", () => {
  const sid = "btaint-pred";
  beforeEach(() => {
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "mail.example/msg-1", TAINTED_BODY);
  });

  it("clears a write whose payload carries nothing from the tainted source", () => {
    expect(browserWriteIsTaintFree(sid, "browser", { action: "fill", value: "Gmail Cleanup Tool for the marketing team" }, ["web"])).toBe(true);
  });

  it("clears a write that carries NO payload — a click cannot exfiltrate", () => {
    expect(browserWriteIsTaintFree(sid, "browser", { action: "click", ref: 3 }, ["web"])).toBe(true);
  });

  /**
   * The known limit, deliberate. Overlap is detected on 24-character windows,
   * so a shorter payload yields no fingerprints and absence cannot be proven —
   * and that is precisely where a short secret lives (a 2FA code, a recovery
   * token). Clearing on "no evidence" there would hand the injection case the
   * one shape it needs. These keep today's behaviour: blocked, with the card.
   */
  it("refuses a payload too short to be proven clean", () => {
    expect(browserWriteIsTaintFree(sid, "browser", { action: "select", value: "LLC" }, ["web"])).toBe(false);
    expect(browserWriteIsTaintFree(sid, "browser", { action: "fill", value: "Gmail Cleanup Tool" }, ["web"])).toBe(false);
  });

  it("refuses a write whose payload carries the tainted bytes", () => {
    expect(browserWriteIsTaintFree(sid, "browser", { action: "type", text: TAINTED_BODY }, ["web"])).toBe(false);
    // The tainted phrase embedded in otherwise-clean text.
    expect(browserWriteIsTaintFree(sid, "browser", {
      action: "fill", value: "the recovery phrase is velvet-harbor-ninety, please save it somewhere",
    }, ["web"])).toBe(false);
  });

  it("only ever speaks for browser WRITES under untrusted-content taint", () => {
    // Not a write — navigate is a read, judged on the normal path.
    expect(browserWriteIsTaintFree(sid, "browser", { action: "navigate", url: "https://x.example" }, ["web"])).toBe(false);
    // Not the browser.
    expect(browserWriteIsTaintFree(sid, "http_request", { method: "POST", body: "hi" }, ["web"])).toBe(false);
    // A label outside the untrusted-content set is the kernel's to judge.
    expect(browserWriteIsTaintFree(sid, "browser", { action: "fill", value: "Gmail Cleanup Tool for the team" }, ["user-provided"])).toBe(false);
    // No taint at all: nothing to clear, the normal path applies.
    expect(browserWriteIsTaintFree(sid, "browser", { action: "fill", value: "hello there, this is plain text" }, [])).toBe(false);
  });

  it("keeps the presence floor when a taint entry has no captured content", () => {
    const bare = "btaint-bare";
    clearSessionTaint(bare);
    // Recorded with no content: nothing to fingerprint, so no payload can be
    // PROVEN free of it — the conservative answer is "cannot clear".
    recordSensitiveRead(bare, "web", "mail.example/unknown");
    expect(browserWriteIsTaintFree(bare, "browser", { action: "fill", value: "a perfectly ordinary sentence typed into a form" }, ["web"])).toBe(false);
  });
});

/**
 * The blocker a user can clear must SAY it is clearable — the chat card keys off
 * that flag, not off layer names. Asserted against the object the gate actually
 * returns, because the recovery text has been right while the control was
 * unreachable (2026-09-18).
 */
describe("the data-lineage blocker advertises the control its text names", () => {
  it("carries clearable:'declassify' alongside the Declassify & retry guidance", () => {
    const sid = "btaint-blocker";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "mail.example/msg-1", TAINTED_BODY);
    const blocker = probeDataLineage(makeCtx({ action: "fill", value: TAINTED_BODY }, sid));
    expect(blocker).not.toBeNull();
    expect(blocker!.recovery).toContain("Declassify & retry");
    expect(blocker!.clearable).toBe("declassify");
  });
});
