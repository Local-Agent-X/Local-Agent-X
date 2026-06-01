import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { USER_HINTS } from "../src/types.js";
import type { SecurityDecision, ToolResult } from "../src/types.js";
import { evaluateFileAccess } from "../src/security/file-access.js";
import { evaluateShellCommand } from "../src/security/shell-policy.js";
import { evaluateWebFetch } from "../src/security/network-policy.js";
import { SecurityLayer } from "../src/security/index.js";
import { ToolPolicy } from "../src/tool-policy.js";
import { makeThreatEnginePack } from "../src/tool-policy/packs/threat-engine-pack.js";
import { makeDefaultPolicyPack } from "../src/tool-policy/packs/default-policy-pack.js";
import { makeSecurityLayerPack } from "../src/tool-policy/packs/security-layer-pack.js";
import { evaluate as evaluatePolicy } from "../src/tool-policy/evaluator.js";
import { checkCircuit, recordCircuitFailure } from "../src/circuit-breaker.js";
import { renderToolResultForModel } from "../src/tools/result-helpers.js";

/**
 * Pairs with the "translate tool failures, never parrot" prompt rule from
 * commit 5200ea0. Every concrete block site populates a category template
 * from USER_HINTS — those templates are the only thing the model surfaces;
 * the technical `reason` stays for logs/debug. Backward compat: legacy block
 * sites that don't set userHint still render via the reason path.
 */
describe("userHint on blocked-tool responses", () => {
  describe("network category (SSRF, egress, threat-restricted, data lineage)", () => {
    it("network-policy: invalid URL", () => {
      const d = evaluateWebFetch(new Set(), false, "7007", "not a url");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.network);
    });

    it("network-policy: SSRF private IPv4", () => {
      const d = evaluateWebFetch(new Set(), false, "7007", "http://10.0.0.1/admin");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.network);
    });

    it("network-policy: cloud metadata endpoint", () => {
      const d = evaluateWebFetch(new Set(), false, "7007", "http://169.254.169.254/");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.network);
    });

    it("network-policy: egress allowlist rejection", () => {
      const d = evaluateWebFetch(new Set(["example.com"]), true, "7007", "https://attacker.com/", "strict");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.network);
    });

    it("threat-engine pack: restricted external tools tag the network hint", async () => {
      const pack = makeThreatEnginePack({
        isRestricted: () => true,
        // unused by this pack
      } as never);
      const decision = await pack.evaluate(
        { id: "1", name: "http_request", args: { url: "https://example.com" } },
        { sessionId: "s", callContext: "local" },
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.userHint).toBe(USER_HINTS.network);
      }
    });
  });

  describe("file-system category (path traversal, workspace boundary, mode)", () => {
    const ws = join(tmpdir(), "user-hint-fa-ws");
    const allowNothing = () => false;

    it("null byte in path", () => {
      const d = evaluateFileAccess(ws, "common", allowNothing, "read", "foo\x00bar");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.fileSystem);
    });

    it("workspace mode reads outside project", () => {
      const d = evaluateFileAccess(ws, "workspace", allowNothing, "read", "/var/log/something.log");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.fileSystem);
    });

    it("write outside workspace", () => {
      const d = evaluateFileAccess(ws, "common", allowNothing, "write", "/tmp/totally-outside.txt");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.fileSystem);
    });
  });

  describe("secrets category (sensitive paths, protected platform files)", () => {
    const ws = join(tmpdir(), "user-hint-fa-secret");
    const allowNothing = () => false;

    it("sensitive path pattern (.ssh)", () => {
      const d = evaluateFileAccess(ws, "unrestricted", allowNothing, "read", "/home/u/.ssh/id_rsa");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.secrets);
    });

    it("write to platform source (src/) is blocked with secrets hint", () => {
      const target = join(ws, "src", "anything.ts");
      const d = evaluateFileAccess(ws, "unrestricted", allowNothing, "write", target);
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.secrets);
    });
  });

  describe("worktree-isolation category", () => {
    it("delegated agent writing to source code without sandbox", () => {
      const layer = new SecurityLayer(tmpdir(), "common");
      const d = layer.evaluate({
        toolName: "bash",
        args: { command: "ls" },
        sessionId: "agent-no-worktree",
        callContext: "delegated",
      });
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.worktreeIsolation);
    });
  });

  describe("policy category (tool-policy default-deny, hosts, blocked args, rate cap)", () => {
    it("tool-policy default-deny tags policy hint", () => {
      const tp = new ToolPolicy({ defaultDecision: "deny", rules: [] });
      const d = tp.evaluate("some_unknown_tool", {}, "s");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.policy);
    });

    it("tool-policy explicit deny rule tags policy hint", () => {
      const tp = new ToolPolicy({
        defaultDecision: "allow",
        rules: [{ id: "deny-bash", tool: "bash", decision: "deny", reason: "no shell" }],
      });
      const d = tp.evaluate("bash", { command: "ls" }, "s");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.policy);
    });

    it("tool-policy host allowlist rejection tags policy hint", () => {
      const tp = new ToolPolicy({
        defaultDecision: "allow",
        rules: [{
          id: "limit-http",
          tool: "http_request",
          decision: "allow",
          reason: "limited",
          constraints: { allowedHosts: ["example.com"] },
        }],
      });
      const d = tp.evaluate("http_request", { url: "https://attacker.com/x" }, "s");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.policy);
    });

    it("tool-policy rate-cap tags retryExhausted hint", () => {
      const tp = new ToolPolicy({
        defaultDecision: "allow",
        rules: [{
          id: "cap-bash",
          tool: "bash",
          decision: "allow",
          reason: "ok",
          constraints: { maxCallsPerSession: 1 },
        }],
      });
      // First call OK, second exceeds.
      tp.evaluate("bash", { command: "ls" }, "session-cap");
      const d = tp.evaluate("bash", { command: "ls" }, "session-cap");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.retryExhausted);
    });

    it("default-policy pack defaults to policy hint when underlying decision has none", async () => {
      const tp = new ToolPolicy({ defaultDecision: "deny", rules: [] });
      const pack = makeDefaultPolicyPack(tp);
      const decision = await pack.evaluate(
        { id: "1", name: "anything", args: {} },
        { sessionId: "s", callContext: "local" },
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.userHint).toBe(USER_HINTS.policy);
      }
    });
  });

  describe("command/shell category", () => {
    it("shell metacharacters", () => {
      if (process.platform === "win32") return; // win32 path has different rules
      const d = evaluateShellCommand("echo `whoami`");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.commandShell);
    });

    it("dangerous command pattern (rm -rf)", () => {
      const d = evaluateShellCommand("rm -rf /tmp/x");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.commandShell);
    });

    it("heredoc + redirect (silent-noop trap)", () => {
      const d = evaluateShellCommand("cat <<EOF > out.txt\nx\nEOF");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.commandShell);
    });
  });

  describe("retryExhausted category", () => {
    it("circuit breaker open carries retryExhausted hint", () => {
      const sess = "ub-circuit-" + Math.random().toString(36).slice(2);
      // Trip the breaker — default threshold 4
      for (let i = 0; i < 5; i++) recordCircuitFailure(sess, "flaky_tool", "boom");
      const d = checkCircuit(sess, "flaky_tool");
      expect(d.allowed).toBe(false);
      expect(d.userHint).toBe(USER_HINTS.retryExhausted);
    });
  });

  describe("formatter renderToolResultForModel", () => {
    it("emits User hint line first when userHint is in metadata, before Recovery", () => {
      const r: ToolResult = {
        content: "BLOCKED: technical reason here",
        isError: true,
        status: "blocked",
        metadata: {
          layer: "security",
          userHint: USER_HINTS.network,
          recovery: "try a different approach",
        },
      };
      const rendered = renderToolResultForModel(r);
      const lines = rendered.split("\n");
      // Line 0 is the header [blocked, layer="security"]
      expect(lines[0].startsWith("[blocked")).toBe(true);
      // Line 1 is the user hint (first thing after header)
      expect(lines[1]).toBe(`User hint: ${USER_HINTS.network}`);
      // Line 2 is the recovery
      expect(lines[2]).toBe("Recovery: try a different approach");
      // Reason text preserved in the body for debug
      expect(rendered).toContain("BLOCKED: technical reason here");
      // userHint is NOT duplicated in the header keys
      expect(lines[0]).not.toContain("userHint=");
    });

    it("backward-compat: legacy block site with no userHint falls back to reason-only output", () => {
      // A block site that never gained a userHint — the formatter must still
      // render cleanly, with no spurious "User hint:" line, so untouched
      // block sites degrade gracefully instead of leaking a literal
      // "User hint: undefined" string.
      const legacyDecision: SecurityDecision = {
        allowed: false,
        reason: "Blocked: legacy reason with no userHint",
      };
      expect(legacyDecision.userHint).toBeUndefined();

      const r: ToolResult = {
        content: `BLOCKED: ${legacyDecision.reason}`,
        isError: true,
        status: "blocked",
        metadata: { layer: "security" },
      };
      const rendered = renderToolResultForModel(r);
      expect(rendered).not.toContain("User hint:");
      // reason still present in the body
      expect(rendered).toContain("Blocked: legacy reason with no userHint");
    });

    it("backward-compat: pure-legacy ToolResult (no status, no metadata) returns verbatim content", () => {
      const r: ToolResult = { content: "raw content", isError: true };
      expect(renderToolResultForModel(r)).toBe("raw content");
    });
  });

  describe("formatter envelope shape — security layer pack end-to-end", () => {
    it("a SecurityDecision-denied call surfaces userHint through the pack and into the render", async () => {
      const layer = new SecurityLayer(tmpdir(), "common");
      const pack = makeSecurityLayerPack(layer);
      const decision = await pack.evaluate(
        { id: "tc-1", name: "bash", args: { command: "ls" } },
        { sessionId: "agent-no-wt", callContext: "delegated" },
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.userHint).toBe(USER_HINTS.worktreeIsolation);

        // Simulate the executor mapping deny → blocked ToolResult.
        const r: ToolResult = {
          content: `BLOCKED by security: ${decision.reason}`,
          isError: true,
          status: "blocked",
          metadata: { layer: "security", recovery: decision.recovery, userHint: decision.userHint },
        };
        const rendered = renderToolResultForModel(r);
        expect(rendered).toContain(`User hint: ${USER_HINTS.worktreeIsolation}`);
        expect(rendered).toContain("BLOCKED by security");
      }
    });
  });
});
