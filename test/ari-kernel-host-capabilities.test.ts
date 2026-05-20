/**
 * Pins the host-capability contract:
 *
 *   1. After startAriKernel() with ariRequired=true, calls that match
 *      the manifest pass the kernel's capability gate. The specific
 *      "Capability token required" / "No capability grant for tool
 *      class" failure modes that the manifest is meant to resolve do
 *      NOT appear. (Some calls may still be denied by policy — that's
 *      expected; capability is entitlement, policy is decision.)
 *
 *   2. An off-manifest tool class still fails closed at the capability
 *      gate. The grant phase did not wildcard-grant. A new tool class
 *      is a deliberate addition to the manifest, not implicit privilege.
 *
 *   3. The standard tool surface used in production (web_search/get,
 *      read/read, bash/exec, write/write) returns allowed: true — the
 *      regression introduced by commit 66ff35e (ariRequired: true with
 *      no host grants) is resolved.
 *
 *   4. Even with a manifest grant, a call carrying taint that matches a
 *      preset deny rule (deny-tainted-shell) is still denied. Grants
 *      are entitlement; rules are decision — both layers stay live.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ariEvaluate,
  isAriActive,
  startAriKernel,
  stopAriKernel,
} from "../src/ari-kernel.js";

// Every (toolName, action) pair the production toolClassMap can route
// through firewall.execute(). Mirrors HOST_CAPABILITY_MANIFEST, but
// expressed as the toolName the dispatcher receives so we exercise the
// same `ariEvaluate(toolName, action)` call shape as tool-executor.ts.
const MANIFEST_CASES: Array<{ name: string; action: string }> = [
  { name: "web_search", action: "get" },
  { name: "web_fetch", action: "head" },
  { name: "browser", action: "options" },
  { name: "http_request", action: "post" },
  { name: "http_request", action: "put" },
  { name: "http_request", action: "patch" },
  { name: "http_request", action: "delete" },
  { name: "read", action: "read" },
  { name: "write", action: "write" },
  { name: "bash", action: "exec" },
  { name: "memory_save", action: "query" },
  { name: "memory_save", action: "exec" },
  { name: "memory_save", action: "mutate" },
  { name: "memory_search", action: "search" },
  // secret-vault tools have a per-tool action override — the action arg
  // is ignored, the override controls what the kernel sees.
  { name: "browser_capture_to_secret", action: "ignored" },
  { name: "browser_fill_from_secret", action: "ignored" },
  { name: "clipboard_write_from_secret", action: "ignored" },
];

// Tools used on every production call path. These also pass policy with
// the workspace-assistant preset and so should return allowed end-to-end.
const STANDARD_TOOLS: Array<{ name: string; action: string }> = [
  { name: "web_search", action: "get" },
  { name: "read", action: "read" },
  { name: "bash", action: "exec" },
  { name: "write", action: "write" },
];

const CAPABILITY_GATE_REGEX = /Capability token required|No capability grant for tool class/i;

let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ari-test-"));
  await startAriKernel(join(tmp, "audit.db"), "workspace-assistant", true);
});

afterEach(() => {
  stopAriKernel();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("AriKernel host capability manifest", () => {
  it("starts the kernel with ariRequired=true and reports active", () => {
    expect(isAriActive()).toBe(true);
  });

  it("passes the capability gate for every manifest (toolName, action) pair", async () => {
    // Each call gets its own kernel run via beforeEach/afterEach below
    // would cost an audit DB per case. Instead reuse one kernel and just
    // assert the *capability* layer doesn't trip — policy/taint denials
    // are a different layer and are tested separately.
    for (const { name, action } of MANIFEST_CASES) {
      const result = await ariEvaluate(name, action, {});
      expect(
        result.reason,
        `${name}/${action} tripped the capability gate — manifest is missing this pair`,
      ).not.toMatch(CAPABILITY_GATE_REGEX);
    }
  });

  it("returns allowed: true for every standard production tool", async () => {
    // These four are the regression check for commit 66ff35e — they
    // must pass end-to-end with the workspace-assistant preset.
    for (const { name, action } of STANDARD_TOOLS) {
      // Fresh kernel per case so cross-call taint accumulation (e.g.
      // an earlier http.get auto-tainting subsequent shell calls)
      // doesn't poison the assertion.
      stopAriKernel();
      await startAriKernel(join(tmp, `audit-${name}.db`), "workspace-assistant", true);
      const result = await ariEvaluate(name, action, {});
      expect(
        result.allowed,
        `${name}/${action} should be allowed but got: ${result.reason}`,
      ).toBe(true);
    }
  });

  it("fails closed for a tool not in TOOL_CLASS_MAP", async () => {
    // Pre-2026-05-20 unmapped tools fell through to `|| "shell"` and were
    // (usually) denied at the capability layer for the wrong reason — the
    // dev got a confusing "no grant for shell.write" error instead of
    // "you forgot to classify this tool". Now ariEvaluate detects unmapped
    // names up front and returns a clear "not in TOOL_CLASS_MAP" denial.
    const result = await ariEvaluate("__unknown_tool__", "head", {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked|denied|fail-closed|not in TOOL_CLASS_MAP/i);
  });

  it("ariObserve writes internal-class calls into the hash-chained audit DB", async () => {
    // Internal-class tools used to bypass the kernel entirely. Now they
    // route through Firewall.audit() which appends to the same SQLite
    // audit store as gated calls — closing the "kernel only sees half the
    // catalog" gap. Verifies the contract: call ariObserve, the event
    // shows up in firewall.getEvents() with toolClass="internal".
    const { ariObserve, getFirewallForTest } = await import("../src/ari-kernel.js");
    ariObserve("protocol_create", "internal", { name: "smoke-test" }, { sessionId: "chat-test-1234" });
    ariObserve("agent_list", "internal", {}, { sessionId: "chat-test-1234" });

    const fw = getFirewallForTest();
    expect(fw, "firewall should be active in this test").not.toBeNull();
    const events = fw!.getEvents();
    const internalEvents = events.filter((e) => e.toolCall.toolClass === "internal");
    expect(internalEvents.length).toBeGreaterThanOrEqual(2);
    const names = internalEvents.map((e) => e.toolCall.parameters._tool);
    expect(names).toContain("protocol_create");
    expect(names).toContain("agent_list");
    // Hash-chained: each event must have a previousHash linking to its predecessor.
    for (const e of internalEvents) {
      expect(e.previousHash).toBeTruthy();
      expect(e.hash).toBeTruthy();
      expect(e.hash).not.toBe(e.previousHash);
    }
  });

  it("still denies a manifest-granted shell call when web-tainted", async () => {
    // shell.exec IS in the manifest and has a host grant. But the
    // deny-tainted-shell rule (priority 10, see workspace-assistant
    // preset → packages/policies/safe-defaults.yaml) deny-matches
    // tainted shell first. The grant entitles us to ASK; the rule
    // answers no.
    const result = await ariEvaluate("bash", "exec", { command: "id" }, [
      "web",
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked|denied|untrusted|tainted/i);
  });
});
