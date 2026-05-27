import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { SecurityLayer } from "./layer-core.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";
import { evaluateWebFetch } from "./network-policy.js";

// All tests build a SecurityLayer with an explicit fileAccessMode so the
// constructor doesn't read ~/.lax/security.json and produce host-dependent
// results.
const WORKSPACE = "./workspace";

function makeLayer() {
  return new SecurityLayer(WORKSPACE, "common");
}

describe("SecurityLayer kernel-class dispatch", () => {
  // ── 1-3: Named-case behavior must be unchanged ──

  describe("named cases unchanged", () => {
    it("read: same result as evaluateFileAccess", () => {
      const sec = makeLayer();
      const path = resolve(WORKSPACE, "foo.txt");
      const expected = evaluateFileAccess(
        resolve(WORKSPACE),
        "common",
        () => false,
        "read",
        path,
      );
      const d = sec.evaluate({ toolName: "read", args: { path }, sessionId: "t" });
      expect(d.allowed).toBe(expected.allowed);
      expect(d.reason).toBe(expected.reason);
    });

    it("write: same result as evaluateFileAccess", () => {
      const sec = makeLayer();
      const path = resolve(WORKSPACE, "foo.txt");
      const expected = evaluateFileAccess(
        resolve(WORKSPACE),
        "common",
        () => false,
        "write",
        path,
      );
      const d = sec.evaluate({ toolName: "write", args: { path }, sessionId: "t" });
      expect(d.allowed).toBe(expected.allowed);
      expect(d.reason).toBe(expected.reason);
    });

    it("edit: same result as evaluateFileAccess", () => {
      const sec = makeLayer();
      const path = resolve(WORKSPACE, "foo.txt");
      const expected = evaluateFileAccess(
        resolve(WORKSPACE),
        "common",
        () => false,
        "edit",
        path,
      );
      const d = sec.evaluate({ toolName: "edit", args: { path }, sessionId: "t" });
      expect(d.allowed).toBe(expected.allowed);
      expect(d.reason).toBe(expected.reason);
    });

    it("bash: routes through evaluateShellCommand (safe command allowed)", () => {
      const sec = makeLayer();
      const expected = evaluateShellCommand("ls");
      const d = sec.evaluate({ toolName: "bash", args: { command: "ls" }, sessionId: "t" });
      expect(d.allowed).toBe(expected.allowed);
      expect(d.reason).toBe(expected.reason);
    });

    it("bash: blocks shell metacharacters", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "bash",
        args: { command: "ls; rm -rf /" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    it("web_fetch: SSRF gate still fires on private IP", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "web_fetch",
        args: { url: "http://127.0.0.1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    it("web_fetch: public URL allowed", () => {
      const sec = makeLayer();
      const expected = evaluateWebFetch(new Set(), "7007", "https://api.github.com");
      const d = sec.evaluate({
        toolName: "web_fetch",
        args: { url: "https://api.github.com" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(expected.allowed);
    });

    it("http_request: SSRF gate still fires on cloud metadata", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "http_request",
        args: { url: "http://169.254.169.254/metadata" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });
  });

  // ── 4: Browser unchanged ──

  describe("browser unchanged", () => {
    it("localhost navigate allowed", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "browser",
        args: { action: "navigate", url: "http://localhost:3000" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });

    it("127.0.0.1 navigate allowed", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "browser",
        args: { action: "navigate", url: "http://127.0.0.1:8080" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });

    it("private network navigate blocked", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "browser",
        args: { action: "navigate", url: "http://192.168.1.1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    it("public URL navigate allowed", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "browser",
        args: { action: "navigate", url: "https://example.com" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });

    it("invalid URL blocked", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "browser",
        args: { action: "navigate", url: "not-a-url" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    it("non-navigate action allowed (no URL gate)", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "browser",
        args: { action: "click", selector: "#btn" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });
  });

  // ── 5: delete_file now goes through file-access (was default-allow) ──

  describe("delete_file (file-class, path-arg)", () => {
    it("allowed for workspace path", () => {
      const sec = makeLayer();
      const path = resolve(WORKSPACE, "tmp.txt");
      const d = sec.evaluate({
        toolName: "delete_file",
        args: { path },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });

    it("blocked for system path outside user dirs (common mode)", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "delete_file",
        args: { path: "/etc/shadow" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });
  });

  // ── 6-7: http-class dispatch ──

  describe("http-class tools (no explicit case)", () => {
    it("http-class tool with URL goes through SSRF / egress allowlist", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "extract_site_assets",
        args: { url: "http://127.0.0.1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    it("http-class tool with URL allowed for public URL", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "extract_site_assets",
        args: { url: "https://example.com" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });

    it("http-class tool without URL allowed with internal-destination reason", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "email_send",
        args: { to: "a@b.com", subject: "hi", body: "x" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/destination is internal/);
    });
  });

  // ── 8: shell-class non-bash ──

  describe("shell-class non-bash tools", () => {
    it("process_start: allowed with kernel-deferral reason", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "process_start",
        args: { command: "node", args: ["script.js"] },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/shell-class tool/);
    });
  });

  // ── 9: database-class ──

  describe("database-class tools", () => {
    it("sql_query: allowed with kernel-deferral reason", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "sql_query",
        args: { query: "SELECT 1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/database-class tool/);
    });
  });

  // ── 10: retrieval-class ──

  describe("retrieval-class tools", () => {
    it("memory_search: allowed", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "memory_search",
        args: { query: "anything" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/retrieval-class tool/);
    });
  });

  // ── 11: secret-vault-class ──

  describe("secret-vault-class tools", () => {
    it("browser_capture_to_secret: allowed with Ari-kernel-deferral reason", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "browser_capture_to_secret",
        args: { name: "x" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/Ari kernel/);
    });
  });

  // ── 12: internal-class ──

  describe("internal-class tools", () => {
    it("agent_status: allowed via internal-class dispatch", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "agent_status",
        args: {},
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/Internal-class tool/);
    });
  });

  // ── 13-14: unknown tool, with/without mcp signal ──

  describe("unknown tool (not in TOOLS)", () => {
    it("denied when no mcpServer signal", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "made_up_tool",
        args: {},
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/not in registry/);
    });

    it("allowed when mcpServer signal present", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "made_up_tool",
        args: {},
        sessionId: "t",
        mcpServer: "my-server",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/MCP-sourced tool/);
    });
  });
});
