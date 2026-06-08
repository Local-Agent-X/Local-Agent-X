import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  computeArgsFingerprint,
  getApprovalManager,
  isDestructiveCommand,
  requiresIrreversibleConfirm,
} from "./approval-manager.js";
import { classifyToolRisk } from "./autonomy/risk.js";
import type { ServerEvent } from "./types.js";

// Unique per-test session IDs so the singleton ApprovalManager doesn't bleed
// cache state across tests.
let _sid = 0;
function sid(label: string): string {
  return `test-${label}-${++_sid}-${process.hrtime.bigint().toString(36)}`;
}

describe("computeArgsFingerprint — bash/shell", () => {
  it("fingerprints the full command, not just the binary", () => {
    expect(computeArgsFingerprint("bash", { command: "git status" })).toBe("git status");
    expect(computeArgsFingerprint("bash", { command: "git push origin main" })).toBe("git push origin main");
    expect(computeArgsFingerprint("bash", { command: "rm -rf /" })).toBe("rm -rf /");
  });

  it("does NOT collapse different subcommands of the same binary", () => {
    // A grant for a read-only `git log` must not auto-approve a destructive
    // `git push --force` / `git reset --hard` (the over-approval defect).
    const log = computeArgsFingerprint("bash", { command: "git log" });
    expect(computeArgsFingerprint("bash", { command: "git push --force" })).not.toBe(log);
    expect(computeArgsFingerprint("bash", { command: "git reset --hard" })).not.toBe(log);
  });

  it("git and rm produce different fingerprints", () => {
    const a = computeArgsFingerprint("bash", { command: "git status" });
    const b = computeArgsFingerprint("bash", { command: "rm -rf /" });
    expect(a).not.toBe(b);
  });

  it("strips leading env-var assignments", () => {
    expect(computeArgsFingerprint("bash", { command: "FOO=bar git status" })).toBe("git status");
    expect(computeArgsFingerprint("bash", { command: "FOO=bar BAZ=qux git push" })).toBe("git push");
  });

  it("normalizes surrounding and internal whitespace", () => {
    expect(computeArgsFingerprint("bash", { command: "   ls   " })).toBe("ls");
    expect(computeArgsFingerprint("bash", { command: "git   status" })).toBe("git status");
  });

  it("retains pipes / chain operators (full command is the key)", () => {
    expect(computeArgsFingerprint("bash", { command: "cat file|grep x" })).toBe("cat file|grep x");
    expect(computeArgsFingerprint("bash", { command: "ls && rm -rf /" })).toBe("ls && rm -rf /");
  });

  it("treats shell and ari_shell the same as bash", () => {
    expect(computeArgsFingerprint("shell", { command: "git status" })).toBe("git status");
    expect(computeArgsFingerprint("ari_shell", { command: "git status" })).toBe("git status");
  });

  it("fingerprints the structured {executable, args[]} form distinctly", () => {
    // The structured ari_shell form has no `command`; previously it collapsed
    // to "" so every structured call shared one grant. `ls` and `rm -rf /`
    // must fingerprint differently.
    const ls = computeArgsFingerprint("ari_shell", { executable: "ls" });
    const rm = computeArgsFingerprint("ari_shell", { executable: "rm", args: ["-rf", "/"] });
    expect(ls).not.toBe(rm);
    expect(ls).toBe("ls");
    expect(rm).toBe("rm -rf /");
  });

  it("folds cwd into the structured fingerprint", () => {
    const a = computeArgsFingerprint("ari_shell", { executable: "ls", cwd: "/a" });
    const b = computeArgsFingerprint("ari_shell", { executable: "ls", cwd: "/b" });
    expect(a).not.toBe(b);
  });

  it("preserves the string-form fingerprint when command is present", () => {
    // Pure string-`command` calls must hash identically to before (so existing
    // session approvals aren't invalidated) — executable/args only fold in
    // when command is absent.
    expect(computeArgsFingerprint("ari_shell", { command: "rm -rf /" })).toBe("rm -rf /");
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

    // Third: re-running the identical `rm -rf /` should short-circuit (cache hit).
    const { emit: e3, cap: c3 } = captureEmit();
    const p3 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-3",
      sessionId,
      context: "",
      args: { command: "rm -rf /" },
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

describe("ApprovalManager — same-command cache hit", () => {
  it("bash: approving `git status` auto-resolves an identical `git status` but re-prompts `git push`", async () => {
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

    // Identical command → cache hit, resolves immediately, no new prompt.
    const { emit: e2, cap: c2 } = captureEmit();
    const p2 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-2",
      sessionId,
      context: "",
      args: { command: "git status" },
      emit: e2,
    });
    await expect(p2).resolves.toBe(true);
    expect(c2.events.filter((e) => e.type === "approval_requested")).toHaveLength(0);

    // Different subcommand → no cache hit, must re-prompt (the over-approval fix).
    const { emit: e3, cap: c3 } = captureEmit();
    let resolved3 = false;
    const p3 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc-3",
      sessionId,
      context: "",
      args: { command: "git push origin main" },
      emit: e3,
    }).then((v) => { resolved3 = true; return v; });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved3).toBe(false);
    expect(c3.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
    mgr.resolveApproval(c3.lastApprovalId!, false, false);
    await expect(p3).resolves.toBe(false);

    mgr.clearSession(sessionId);
  });
});

describe("isDestructiveCommand — structured {executable, args[]} form", () => {
  // Regression for the silent-RCE gap: the matcher used to read ONLY
  // args.command, so an ari_shell call that passed {executable:"rm",
  // args:["-rf","/"]} bypassed the destructive floor entirely.
  it("matches a synthesized command against the text patterns", () => {
    expect(isDestructiveCommand("ari_shell", { executable: "rm", args: ["-rf", "/tmp/x"] }))
      .not.toBeNull();
  });

  it("matches a destructive binary by basename regardless of args", () => {
    // No -rf flag, so the text pattern doesn't fire — the basename set must.
    expect(isDestructiveCommand("ari_shell", { executable: "rm", args: ["foo"] })).not.toBeNull();
    expect(isDestructiveCommand("ari_shell", { executable: "shred", args: ["f"] })).not.toBeNull();
    expect(isDestructiveCommand("ari_shell", { executable: "mkfs.ext4", args: ["/dev/sda"] }))
      .not.toBeNull();
  });

  it("matches a destructive binary given by absolute path (basename resolved)", () => {
    expect(isDestructiveCommand("ari_shell", { executable: "/bin/rm", args: ["x"] })).not.toBeNull();
  });

  it("does NOT flag a benign structured command", () => {
    expect(isDestructiveCommand("ari_shell", { executable: "ls" })).toBeNull();
    expect(isDestructiveCommand("ari_shell", { executable: "echo", args: ["hi"] })).toBeNull();
  });

  it("forces an irreversible confirm for the structured destructive form", () => {
    expect(requiresIrreversibleConfirm("ari_shell", { executable: "rm", args: ["-rf", "/tmp/x"] }))
      .not.toBeNull();
  });
});

describe("requiresIrreversibleConfirm — the floor", () => {
  // Regression for the gap: the floor used to be shell-text-only, so a
  // destructive NON-shell tool auto-allowed under Power/Autonomous with no
  // confirm. These tools must now hit the floor on their ToolRisk class.
  it("forces a confirm for destructive non-shell tools", () => {
    // Sanity: confirm the taxonomy classes these as "destructive" (the key the
    // floor reads). If a future re-class changes this, the floor coverage moves
    // with it — and this assertion flags the change.
    for (const tool of ["delete_file", "process_kill", "memory_forget", "marketplace_install"]) {
      expect(classifyToolRisk(tool)).toBe("destructive");
    }

    expect(requiresIrreversibleConfirm("delete_file", { path: "/x" })).toMatch(/delete_file/);
    expect(requiresIrreversibleConfirm("process_kill", { pid: 123 })).toMatch(/process_kill/);
    expect(requiresIrreversibleConfirm("memory_forget", { id: "m1" })).toMatch(/memory_forget/);
    expect(requiresIrreversibleConfirm("marketplace_install", { name: "pack" })).toMatch(/marketplace_install/);
  });

  it("preserves the shell-text floor", () => {
    // Identical reasons to isDestructiveCommand — the wrapper passes them through.
    expect(requiresIrreversibleConfirm("bash", { command: "rm -rf /tmp/x" }))
      .toBe(isDestructiveCommand("bash", { command: "rm -rf /tmp/x" }));
    expect(requiresIrreversibleConfirm("bash", { command: "rm -rf /tmp/x" })).toBeTruthy();
    // A benign shell command is NOT a shell-pattern hit; bash itself is risk
    // class "shell", not "destructive", so it falls through to null.
    expect(requiresIrreversibleConfirm("bash", { command: "git status" })).toBeNull();
  });

  it("leaves reversible / safe tools unaffected (no spurious prompt)", () => {
    expect(requiresIrreversibleConfirm("read", { path: "/x" })).toBeNull();
    // workspace-write is reversible (rollback territory) — not the hard floor.
    expect(classifyToolRisk("write")).not.toBe("destructive");
    expect(requiresIrreversibleConfirm("write", { path: "/x" })).toBeNull();
  });

  it("does NOT force money/secrets tools (deliberate Autonomous opt-in is honored)", () => {
    // The floor is scoped to "destructive" only; money/secrets resolve to
    // "ask" everywhere except the explicitly-chosen Autonomous profile.
    expect(requiresIrreversibleConfirm("read", {})).toBeNull();
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
