// Capability-class re-keying — proves the security gates key on CAPABILITY
// CLASS, not literal canonical tool names. The master defect was that the
// ari_* bridge tools and other synonyms (email_send, browser, clipboard_write,
// process_start, ari_file, email_read, memory_search) are the same I/O sinks
// under names no gate recognized, so they bypassed egress / sensitive-read /
// worktree enforcement. These tests assert that synonyms are now enforced
// identically to their canonical equivalents.

import { describe, it, expect, beforeEach } from "vitest";
import { dataLineageGate, egressGuardGate } from "./enforce-policy.js";
import { hasCapability, WORKTREE_PATH_TOOLS } from "../tool-registry.js";
import { WORKTREE_REQUIRED_TOOLS } from "../security/types.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage.js";
import type { ToolCallContext } from "./context.js";

function makeCtx(name: string, args: Record<string, unknown>, sessionId: string): ToolCallContext {
  return {
    tc: { id: "1", name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: undefined as never,
    sessionId,
    callContext: "local",
    args,
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
  } as ToolCallContext;
}

describe("capability-class membership (single source of truth)", () => {
  it("egress class covers canonical http AND every synonym", () => {
    for (const t of ["http_request", "web_fetch", "ari_http", "email_send", "clipboard_write", "process_start", "browser", "browser_navigate"]) {
      expect(hasCapability(t, "egress")).toBe(true);
    }
    // vault-only browser sub-tools are NOT egress (value never enters context).
    expect(hasCapability("browser_fill_from_secret", "egress")).toBe(false);
    expect(hasCapability("read", "egress")).toBe(false);
  });

  it("sensitive-read class covers canonical AND synonyms", () => {
    for (const t of ["read", "bash", "sql_query", "ari_file", "email_read", "memory_search", "grep", "glob", "ari_retrieval", "ari_database", "ari_sqlite"]) {
      expect(hasCapability(t, "sensitive-read")).toBe(true);
    }
    expect(hasCapability("http_request", "sensitive-read")).toBe(false);
  });

  it("worktree path tools + WORKTREE_REQUIRED include ari_file", () => {
    expect(WORKTREE_PATH_TOOLS.has("ari_file")).toBe(true);
    for (const t of ["read", "write", "edit", "glob", "grep"]) expect(WORKTREE_PATH_TOOLS.has(t)).toBe(true);
    // WORKTREE_REQUIRED_TOOLS: canonical preserved + synonyms added.
    for (const t of ["write", "edit", "bash", "ari_file", "ari_shell", "process_start"]) {
      expect(WORKTREE_REQUIRED_TOOLS.has(t)).toBe(true);
    }
  });
});

describe("dataLineageGate keys on egress class (not just http_request)", () => {
  const sessionId = "cap-class-taint";
  beforeEach(() => {
    clearSessionTaint(sessionId);
    // Arm the gate: a sensitive read occurred this session.
    recordSensitiveRead(sessionId, "sensitive_file", "/Users/x/.ssh/id_rsa");
  });

  it("blocks ALL egress-class sinks when the session is tainted", () => {
    for (const name of ["http_request", "ari_http", "email_send", "clipboard_write", "process_start", "browser_navigate"]) {
      const ctx = makeCtx(name, {}, sessionId);
      const outcome = dataLineageGate(ctx);
      expect(outcome.kind).toBe("halt");
      expect(ctx.allowed).toBe(false);
      expect(ctx.result?.metadata?.layer).toBe("data-lineage");
    }
  });

  it("does NOT block non-egress sinks even when tainted", () => {
    const ctx = makeCtx("read", { path: "/tmp/x" }, sessionId);
    expect(dataLineageGate(ctx).kind).toBe("continue");
  });

  it("does NOT block egress when the session is clean (untainted)", () => {
    const clean = "cap-class-clean";
    clearSessionTaint(clean);
    const ctx = makeCtx("email_send", { to: "a@b.com", body: "hi" }, clean);
    expect(dataLineageGate(ctx).kind).toBe("continue");
  });
});

describe("egressGuardGate — outbound secret scan + sensitive attachment (every egress sink)", () => {
  const sessionId = "cap-class-egress-guard";
  // A clearly secret-shaped value (AWS Access Key: AKIA + 16 upper/digit chars).
  const SECRET = "AKIA0000000000000000";

  it("blocks a hardcoded secret in clipboard_write content", () => {
    const ctx = makeCtx("clipboard_write", { text: `token=${SECRET}` }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.layer).toBe("egress-guard");
  });

  it("blocks a hardcoded secret in process_start command/args", () => {
    const ctx = makeCtx("process_start", { command: "deploy", args: [`--key=${SECRET}`] }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("halt");
  });

  it("blocks a hardcoded secret in an email_send body", () => {
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `here: ${SECRET}` }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("halt");
  });

  it("lets a clean payload through, and passes {{SECRET_NAME}} placeholders", () => {
    expect(egressGuardGate(makeCtx("clipboard_write", { text: "hello world" }, sessionId)).kind).toBe("continue");
    expect(egressGuardGate(makeCtx("email_send", { to: "a@b.com", subject: "x", body: "use {{API_KEY}}" }, sessionId)).kind).toBe("continue");
  });

  it("rejects email_send attaching a sensitive file path", () => {
    const ctx = makeCtx("email_send", {
      to: "a@b.com", subject: "x", body: "see attached",
      attachments: JSON.stringify(["~/.ssh/id_rsa", "/tmp/notes.txt"]),
    }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.blocked_by).toBe("sensitive-attachment");
  });

  it("allows email_send with a benign attachment", () => {
    const ctx = makeCtx("email_send", {
      to: "a@b.com", subject: "x", body: "see attached",
      attachments: JSON.stringify(["/tmp/report.pdf"]),
    }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("continue");
  });

  it("is a no-op for non-egress tools", () => {
    expect(egressGuardGate(makeCtx("read", { path: "/tmp/x" }, sessionId)).kind).toBe("continue");
  });
});
