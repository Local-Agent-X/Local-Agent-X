import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { computeArgsFingerprint, getApprovalManager } from "./approval-manager.js";
import type { ServerEvent } from "./types.js";

// Unique per-test session IDs so the singleton ApprovalManager doesn't bleed
// cache state across tests.
let _sid = 0;
function sid(label: string): string {
  return `test-${label}-${++_sid}-${process.hrtime.bigint().toString(36)}`;
}

describe("computeArgsFingerprint — bash/shell", () => {
  it("extracts the binary as fingerprint", () => {
    expect(computeArgsFingerprint("bash", { command: "git status" })).toBe("git");
    expect(computeArgsFingerprint("bash", { command: "git push origin main" })).toBe("git");
    expect(computeArgsFingerprint("bash", { command: "rm -rf /" })).toBe("rm");
  });

  it("git and rm produce different fingerprints", () => {
    const a = computeArgsFingerprint("bash", { command: "git status" });
    const b = computeArgsFingerprint("bash", { command: "rm -rf /" });
    expect(a).not.toBe(b);
  });

  it("strips leading env-var assignments", () => {
    expect(computeArgsFingerprint("bash", { command: "FOO=bar git status" })).toBe("git");
    expect(computeArgsFingerprint("bash", { command: "FOO=bar BAZ=qux git push" })).toBe("git");
  });

  it("trims leading and trailing whitespace", () => {
    expect(computeArgsFingerprint("bash", { command: "   ls   " })).toBe("ls");
  });

  it("stops at pipe / chain operators", () => {
    expect(computeArgsFingerprint("bash", { command: "cat file|grep x" })).toBe("cat");
    expect(computeArgsFingerprint("bash", { command: "ls && rm -rf /" })).toBe("ls");
    expect(computeArgsFingerprint("bash", { command: "echo hi; rm x" })).toBe("echo");
  });

  it("lowercases binary names", () => {
    expect(computeArgsFingerprint("bash", { command: "GIT status" })).toBe("git");
  });

  it("treats shell and ari_shell the same as bash", () => {
    expect(computeArgsFingerprint("shell", { command: "git status" })).toBe("git");
    expect(computeArgsFingerprint("ari_shell", { command: "git status" })).toBe("git");
  });
});

describe("computeArgsFingerprint — file path tools", () => {
  it("uses parent directory of resolved path", () => {
    const fp = computeArgsFingerprint("write", { path: "/Users/x/Documents/foo.txt" });
    expect(fp).toBe(path.dirname(path.resolve("/Users/x/Documents/foo.txt")));
  });

  it("different parent dirs produce different fingerprints", () => {
    const docs = computeArgsFingerprint("write", { path: "/Users/x/Documents/a.txt" });
    const ssh = computeArgsFingerprint("write", { path: "/Users/x/.ssh/id_rsa" });
    expect(docs).not.toBe(ssh);
  });

  it("same parent dir produces same fingerprint across files", () => {
    const a = computeArgsFingerprint("write", { path: "/Users/x/Documents/a.txt" });
    const b = computeArgsFingerprint("write", { path: "/Users/x/Documents/b.txt" });
    expect(a).toBe(b);
  });

  it("edit and delete_file behave like write", () => {
    const w = computeArgsFingerprint("write", { path: "/tmp/foo.txt" });
    const e = computeArgsFingerprint("edit", { path: "/tmp/foo.txt" });
    const d = computeArgsFingerprint("delete_file", { path: "/tmp/foo.txt" });
    expect(w).toBe(e);
    expect(e).toBe(d);
  });

  it("missing path → <unresolvable>", () => {
    expect(computeArgsFingerprint("write", {})).toBe("<unresolvable>");
    expect(computeArgsFingerprint("write", { path: "" })).toBe("<unresolvable>");
  });
});

describe("computeArgsFingerprint — network tools", () => {
  it("uses hostname", () => {
    expect(computeArgsFingerprint("http_request", { url: "https://example.com/foo" })).toBe("example.com");
    expect(computeArgsFingerprint("web_fetch", { url: "https://example.com/bar?q=1" })).toBe("example.com");
  });

  it("different hosts produce different fingerprints", () => {
    const a = computeArgsFingerprint("http_request", { url: "https://example.com/x" });
    const b = computeArgsFingerprint("http_request", { url: "https://attacker.com/x" });
    expect(a).not.toBe(b);
  });

  it("malformed url → <malformed>", () => {
    expect(computeArgsFingerprint("http_request", { url: "garbage url" })).toBe("<malformed>");
    expect(computeArgsFingerprint("http_request", {})).toBe("<malformed>");
  });
});

describe("computeArgsFingerprint — browser", () => {
  it("uses action", () => {
    expect(computeArgsFingerprint("browser", { action: "click" })).toBe("click");
    expect(computeArgsFingerprint("browser", { action: "navigate" })).toBe("navigate");
  });

  it("different actions produce different fingerprints", () => {
    const a = computeArgsFingerprint("browser", { action: "click" });
    const b = computeArgsFingerprint("browser", { action: "navigate" });
    expect(a).not.toBe(b);
  });
});

describe("computeArgsFingerprint — default", () => {
  it("unlisted tool → *", () => {
    expect(computeArgsFingerprint("memory_save", { content: "hello" })).toBe("*");
    expect(computeArgsFingerprint("some_unknown_tool", { foo: 1, bar: 2 })).toBe("*");
  });

  it("different args still collapse to same * key (preserves old behavior)", () => {
    const a = computeArgsFingerprint("memory_save", { content: "hello" });
    const b = computeArgsFingerprint("memory_save", { content: "totally different" });
    expect(a).toBe(b);
  });
});

describe("computeArgsFingerprint — stability", () => {
  it("returns the same value across repeated calls (no Date.now / no random)", () => {
    const inputs: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "git status" }],
      ["bash", { command: "FOO=bar rm -rf /" }],
      ["write", { path: "/Users/x/Documents/foo.txt" }],
      ["http_request", { url: "https://example.com/x" }],
      ["browser", { action: "click" }],
      ["memory_save", { content: "hi" }],
    ];
    for (const [tool, args] of inputs) {
      const a = computeArgsFingerprint(tool, args);
      const b = computeArgsFingerprint(tool, args);
      const c = computeArgsFingerprint(tool, args);
      expect(a).toBe(b);
      expect(b).toBe(c);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests against the singleton ApprovalManager. We drive
// requestApproval directly, watch the `approval_requested` emit for the id,
// then call resolveApproval. Per-test session IDs keep the cache isolated.
// ---------------------------------------------------------------------------

interface Captured {
  events: ServerEvent[];
  lastApprovalId: string | null;
}

function captureEmit(): { emit: (e: ServerEvent) => void; cap: Captured } {
  const cap: Captured = { events: [], lastApprovalId: null };
  return {
    cap,
    emit: (e: ServerEvent) => {
      cap.events.push(e);
      if (e.type === "approval_requested") cap.lastApprovalId = e.approvalId;
    },
  };
}

describe("ApprovalManager — scope tightness", () => {
  it("bash: approving `git status` does NOT auto-resolve `rm -rf /`", async () => {
    const mgr = getApprovalManager();
    const sessionId = sid("scope-bash");

    // First: request approval for `git status`, click "always allow".
    const { emit: e1, cap: c1 } = captureEmit();
    const p1 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-1",
      sessionId,
      context: "",
      args: { command: "git status" },
      emit: e1,
    });
    expect(c1.lastApprovalId).toBeTruthy();
    expect(mgr.resolveApproval(c1.lastApprovalId!, true, true)).toBe(true);
    await expect(p1).resolves.toBe(true);

    // Second: request approval for `rm -rf /`. Must NOT short-circuit.
    const { emit: e2, cap: c2 } = captureEmit();
    let resolved2 = false;
    const p2 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-2",
      sessionId,
      context: "",
      args: { command: "rm -rf /" },
      emit: e2,
    }).then((v) => { resolved2 = true; return v; });

    // Flush microtasks to confirm it's actually pending, not already settled.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved2).toBe(false);
    expect(c2.lastApprovalId).toBeTruthy();
    expect(c2.lastApprovalId).not.toBe(c1.lastApprovalId);

    // Now approve the rm; both fingerprints should live in the cache.
    expect(mgr.resolveApproval(c2.lastApprovalId!, true, true)).toBe(true);
    await expect(p2).resolves.toBe(true);

    // Third: a fresh `rm` call should now short-circuit (cache hit for rm).
    const { emit: e3, cap: c3 } = captureEmit();
    const p3 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-3",
      sessionId,
      context: "",
      args: { command: "rm somefile" },
      emit: e3,
    });
    await expect(p3).resolves.toBe(true);
    // No new approval_requested event — short-circuit returns synchronously.
    expect(c3.events.filter((e) => e.type === "approval_requested")).toHaveLength(0);

    mgr.clearSession(sessionId);
  });

  it("write: approving ~/Documents does NOT auto-resolve ~/.ssh", async () => {
    const mgr = getApprovalManager();
    const sessionId = sid("scope-write");

    const { emit: e1, cap: c1 } = captureEmit();
    const p1 = mgr.requestApproval({
      toolName: "write",
      toolCallId: "tc-1",
      sessionId,
      context: "",
      args: { path: "/Users/x/Documents/a.txt" },
      emit: e1,
    });
    expect(c1.lastApprovalId).toBeTruthy();
    mgr.resolveApproval(c1.lastApprovalId!, true, true);
    await expect(p1).resolves.toBe(true);

    const { emit: e2, cap: c2 } = captureEmit();
    let resolved2 = false;
    const p2 = mgr.requestApproval({
      toolName: "write",
      toolCallId: "tc-2",
      sessionId,
      context: "",
      args: { path: "/Users/x/.ssh/id_rsa" },
      emit: e2,
    }).then((v) => { resolved2 = true; return v; });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved2).toBe(false);
    expect(c2.lastApprovalId).toBeTruthy();

    mgr.resolveApproval(c2.lastApprovalId!, false);
    await expect(p2).resolves.toBe(false);

    mgr.clearSession(sessionId);
  });
});

describe("ApprovalManager — same-bucket cache hit", () => {
  it("bash: approving `git status` DOES auto-resolve `git push`", async () => {
    const mgr = getApprovalManager();
    const sessionId = sid("hit-bash");

    const { emit: e1, cap: c1 } = captureEmit();
    const p1 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-1",
      sessionId,
      context: "",
      args: { command: "git status" },
      emit: e1,
    });
    mgr.resolveApproval(c1.lastApprovalId!, true, true);
    await expect(p1).resolves.toBe(true);

    const { emit: e2, cap: c2 } = captureEmit();
    const p2 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-2",
      sessionId,
      context: "",
      args: { command: "git push origin main" },
      emit: e2,
    });
    // Should resolve immediately via cache — no approval_requested emitted.
    await expect(p2).resolves.toBe(true);
    expect(c2.events.filter((e) => e.type === "approval_requested")).toHaveLength(0);

    mgr.clearSession(sessionId);
  });
});

describe("ApprovalManager — clearSession", () => {
  it("drops all cached entries for the session", async () => {
    const mgr = getApprovalManager();
    const sessionId = sid("clear");

    // Seed cache with two distinct entries.
    const { emit: e1, cap: c1 } = captureEmit();
    const p1 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-1",
      sessionId,
      context: "",
      args: { command: "git status" },
      emit: e1,
    });
    mgr.resolveApproval(c1.lastApprovalId!, true, true);
    await p1;

    const { emit: e2, cap: c2 } = captureEmit();
    const p2 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-2",
      sessionId,
      context: "",
      args: { command: "ls -la" },
      emit: e2,
    });
    mgr.resolveApproval(c2.lastApprovalId!, true, true);
    await p2;

    // Clear, then expect the next call to NOT auto-resolve.
    mgr.clearSession(sessionId);

    const { emit: e3, cap: c3 } = captureEmit();
    let resolved3 = false;
    const p3 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-3",
      sessionId,
      context: "",
      args: { command: "git status" },
      emit: e3,
    }).then((v) => { resolved3 = true; return v; });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved3).toBe(false);
    expect(c3.lastApprovalId).toBeTruthy();

    mgr.resolveApproval(c3.lastApprovalId!, false);
    await expect(p3).resolves.toBe(false);
  });
});
