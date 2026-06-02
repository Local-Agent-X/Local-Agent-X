import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  computeArgsFingerprint,
  getApprovalManager,
} from "../src/approval-manager.js";
import type { ServerEvent } from "../src/types.js";

// computeArgsFingerprint + cacheKeyFor (the cache key is exercised through the
// public ApprovalManager surface). The fingerprint keys the session
// auto-approve cache, so risk-bearing args MUST change it — otherwise a grant
// for one command/host/dir silently covers an unrelated, higher-risk call.

describe("computeArgsFingerprint", () => {
  describe("bash / shell binary extraction", () => {
    it("distinguishes two different binaries (git vs rm)", () => {
      const a = computeArgsFingerprint("bash", { command: "git status" });
      const b = computeArgsFingerprint("bash", { command: "rm -rf /" });
      expect(a).not.toBe(b);
    });

    it("strips leading env-var assignments but keeps the full command", () => {
      const withEnv = computeArgsFingerprint("bash", {
        command: "FOO=bar BAZ=qux git status",
      });
      const plain = computeArgsFingerprint("bash", { command: "git status" });
      expect(withEnv).toBe(plain);
      expect(withEnv).toBe("git status");
    });

    it("is case-insensitive on the tool name but preserves command case", () => {
      expect(computeArgsFingerprint("BASH", { command: "GIT status" })).toBe(
        "GIT status",
      );
      expect(computeArgsFingerprint("ari_shell", { command: "ls -la" })).toBe(
        "ls -la",
      );
    });

    it("returns empty string for a missing/non-string command", () => {
      expect(computeArgsFingerprint("bash", {})).toBe("");
      expect(computeArgsFingerprint("bash", { command: 42 })).toBe("");
    });

    // The fingerprint keys on the FULL command, so risk-bearing subcommands and
    // flags don't collapse together: a "remember for session" grant on a benign
    // `git log` must NOT auto-approve a destructive `git push --force`.
    it("`git log` and `git push --force` get distinct fingerprints", () => {
      const benign = computeArgsFingerprint("bash", { command: "git log" });
      const risky = computeArgsFingerprint("bash", {
        command: "git push --force",
      });
      expect(benign).toBe("git log");
      expect(risky).toBe("git push --force");
      expect(benign).not.toBe(risky);
    });
  });

  describe("write / edit / delete_file parent-dir extraction", () => {
    it("distinguishes two distinct parent directories", () => {
      const a = computeArgsFingerprint("write", { path: "/tmp/aaa/file.txt" });
      const b = computeArgsFingerprint("write", { path: "/tmp/bbb/file.txt" });
      expect(a).not.toBe(b);
    });

    it("maps two files in the same directory to the same fingerprint", () => {
      const a = computeArgsFingerprint("edit", { path: "/tmp/aaa/one.txt" });
      const b = computeArgsFingerprint("edit", { path: "/tmp/aaa/two.txt" });
      expect(a).toBe(b);
    });

    it("returns <unresolvable> for a missing path", () => {
      expect(computeArgsFingerprint("delete_file", {})).toBe("<unresolvable>");
    });
  });

  describe("http_request / web_fetch hostname extraction", () => {
    it("distinguishes two distinct hosts", () => {
      const a = computeArgsFingerprint("http_request", {
        url: "https://evil.example.com/x",
      });
      const b = computeArgsFingerprint("http_request", {
        url: "https://good.example.com/x",
      });
      expect(a).not.toBe(b);
      expect(a).toBe("evil.example.com");
    });

    it("ignores path/query — same host is the same fingerprint", () => {
      const a = computeArgsFingerprint("web_fetch", {
        url: "https://api.example.com/a?z=1",
      });
      const b = computeArgsFingerprint("web_fetch", {
        url: "https://api.example.com/b",
      });
      expect(a).toBe(b);
    });

    it("returns <malformed> for an unparseable url", () => {
      expect(computeArgsFingerprint("http_request", { url: "not a url" })).toBe(
        "<malformed>",
      );
      expect(computeArgsFingerprint("web_fetch", {})).toBe("<malformed>");
    });
  });

  describe("browser action + fallthrough", () => {
    it("keys on the browser action", () => {
      expect(computeArgsFingerprint("browser", { action: "click" })).toBe(
        "click",
      );
      expect(
        computeArgsFingerprint("browser", { action: "click" }),
      ).not.toBe(computeArgsFingerprint("browser", { action: "navigate" }));
    });

    it("returns * for an unknown tool", () => {
      expect(computeArgsFingerprint("some_unknown_tool", { x: 1 })).toBe("*");
    });
  });
});

describe("ApprovalManager auto-approve cache keying (cacheKey via public surface)", () => {
  let mgr: ReturnType<typeof getApprovalManager>;
  const SESSION = "sess-fp-test";

  // Drives a full request → resolve(remember) → re-request cycle and reports
  // whether the second request was auto-approved by the session cache.
  async function grantAndCheck(
    first: { toolName: string; args: Record<string, unknown> },
    second: { toolName: string; args: Record<string, unknown> },
  ): Promise<boolean> {
    const events: ServerEvent[] = [];
    const emit = (e: ServerEvent) => events.push(e);

    const p1 = mgr.requestApproval({
      toolName: first.toolName,
      toolCallId: "tc1",
      sessionId: SESSION,
      context: "ctx",
      args: first.args,
      emit,
    });
    const requested = events.find((e) => e.type === "approval_requested") as
      | (ServerEvent & { approvalId: string })
      | undefined;
    expect(requested).toBeTruthy();
    // Approve AND remember for the session.
    mgr.resolveApproval(requested!.approvalId, true, true);
    expect(await p1).toBe(true);

    // Second call: if the cache key matches, requestApproval short-circuits and
    // returns an already-resolved promise (true) with NO new
    // approval_requested event. If it does NOT match, it registers a pending
    // approval (emitting approval_requested) whose promise stays unresolved
    // until timeout — so we must not await it unconditionally.
    const before = events.length;
    const p2 = mgr.requestApproval({
      toolName: second.toolName,
      toolCallId: "tc2",
      sessionId: SESSION,
      context: "ctx",
      args: second.args,
      emit,
    });
    const newRequest = events
      .slice(before)
      .some((e) => e.type === "approval_requested");

    if (newRequest) {
      // Not auto-approved: a fresh prompt was emitted. Tear down the pending
      // approval so its promise resolves (false) and nothing leaks.
      mgr.clearSession(SESSION);
      await p2;
      return false;
    }
    // No new prompt → must have been an immediate auto-approval.
    return (await p2) === true;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mgr = getApprovalManager();
    mgr.clearSession(SESSION);
  });

  afterEach(() => {
    mgr.clearSession(SESSION);
    vi.useRealTimers();
  });

  it("auto-approves the identical command after a remembered grant", async () => {
    expect(
      await grantAndCheck(
        { toolName: "bash", args: { command: "git status" } },
        { toolName: "bash", args: { command: "git status" } },
      ),
    ).toBe(true);
  });

  it("does NOT auto-approve a different binary (rm) after granting git", async () => {
    expect(
      await grantAndCheck(
        { toolName: "bash", args: { command: "git status" } },
        { toolName: "bash", args: { command: "rm -rf /" } },
      ),
    ).toBe(false);
  });

  it("does NOT auto-approve a different host after granting one host", async () => {
    expect(
      await grantAndCheck(
        { toolName: "http_request", args: { url: "https://a.example.com/x" } },
        { toolName: "http_request", args: { url: "https://b.example.com/x" } },
      ),
    ).toBe(false);
  });

  // Because the fingerprint is the full command, a remembered grant on a benign
  // `git log` does NOT auto-approve a destructive `git push --force`.
  it("granting `git log` does NOT auto-approve `git push --force`", async () => {
    expect(
      await grantAndCheck(
        { toolName: "bash", args: { command: "git log" } },
        { toolName: "bash", args: { command: "git push --force" } },
      ),
    ).toBe(false);
  });
});

describe("ApprovalManager.resolveApproval — timeout is never cached as approved", () => {
  let mgr: ReturnType<typeof getApprovalManager>;
  const SESSION = "sess-timeout-test";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mgr = getApprovalManager();
    mgr.clearSession(SESSION);
  });

  afterEach(() => {
    mgr.clearSession(SESSION);
    vi.useRealTimers();
  });

  it("resolves a timed-out approval to false and does not auto-approve later", async () => {
    const events: ServerEvent[] = [];
    const emit = (e: ServerEvent) => events.push(e);

    const p1 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc1",
      sessionId: SESSION,
      context: "ctx",
      args: { command: "git status" },
      emit,
    });

    // Fast-forward past APPROVAL_TIMEOUT_MS (5 min).
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(await p1).toBe(false);
    expect(events.some((e) => e.type === "approval_timeout")).toBe(true);

    // A timed-out approval must NOT be remembered: the next identical request
    // must prompt again (new approval_requested), not short-circuit.
    const before = events.length;
    const p2 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc2",
      sessionId: SESSION,
      context: "ctx",
      args: { command: "git status" },
      emit,
    });
    const reprompted = events
      .slice(before)
      .some((e) => e.type === "approval_requested");
    expect(reprompted).toBe(true);

    // Clean up the still-pending second approval.
    mgr.clearSession(SESSION);
    expect(await p2).toBe(false);
  });

  it("resolveApproval on a timed-out (already-deleted) id returns false / no-op", async () => {
    const events: ServerEvent[] = [];
    const emit = (e: ServerEvent) => events.push(e);

    const p1 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc1",
      sessionId: SESSION,
      context: "ctx",
      args: { command: "git status" },
      emit,
    });
    const requested = events.find((e) => e.type === "approval_requested") as
      | (ServerEvent & { approvalId: string })
      | undefined;
    expect(requested).toBeTruthy();

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(await p1).toBe(false);

    // Late resolve attempt: the pending entry is gone, so this is a no-op and
    // crucially cannot retroactively cache the (tool,args) as approved.
    const accepted = mgr.resolveApproval(requested!.approvalId, true, true);
    expect(accepted).toBe(false);

    // Confirm no auto-approval leaked in: a fresh identical request re-prompts.
    const before = events.length;
    const p2 = mgr.requestApproval({
      toolName: "bash",
      toolCallId: "tc3",
      sessionId: SESSION,
      context: "ctx",
      args: { command: "git status" },
      emit,
    });
    expect(
      events.slice(before).some((e) => e.type === "approval_requested"),
    ).toBe(true);

    mgr.clearSession(SESSION);
    expect(await p2).toBe(false);
  });
});
