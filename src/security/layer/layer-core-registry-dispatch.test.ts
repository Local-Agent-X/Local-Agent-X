import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SecurityLayer } from "./layer-core.js";

const WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-ws-")));
const WORKSPACE = join(WORKSPACE_ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
afterAll(() => rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));

function makeLayer() {
  return new SecurityLayer(WORKSPACE, "common");
}


  describe("database-class tools", () => {
    // No caller `database` path → internal managed store (ari_*-style).
    // Must keep passing.
    it("sql_query with no database arg: allowed (managed store)", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "sql_query",
        args: { query: "SELECT 1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/managed-store database tool/);
});
    // A caller path inside the project tree is gated as a read and allowed
    // (common mode permits reads in the project root).
    it("sql_query against a project-tree path: allowed (read-gated)", () => {
      const sec = makeLayer();
      const dbPath = resolve(WORKSPACE, "data.db");
      const d = sec.evaluate({
        toolName: "sql_query",
        args: { database: dbPath, query: "SELECT 1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });

    // A caller path OUTSIDE project / ~/.lax / user dirs is blocked in
    // common mode. tmpdir() is none of those on either platform.
    it("sql_query against an outside path: blocked (read-gated)", () => {
      const sec = makeLayer();
      const dbPath = join(tmpdir(), "lax-sql-outside-read.db");
      const d = sec.evaluate({
        toolName: "sql_query",
        args: { database: dbPath, query: "SELECT 1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    // A sensitive-pattern path (encrypted secrets store) is blocked even
    // though ~/.lax is otherwise readable — SENSITIVE_PATTERNS catches it.
    it("sql_query against a sensitive-pattern path: blocked", () => {
      const sec = makeLayer();
      const dbPath = "~/.lax/secrets.enc";
      const d = sec.evaluate({
        toolName: "sql_query",
        args: { database: dbPath, query: "SELECT 1" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    // readonly:false gates as a WRITE — common mode blocks writes outside
    // the workspace, so even a project-tree path that reads fine is blocked
    // for mutation.
    it("sql_query readonly:false to an outside path: blocked (write-gated)", () => {
      const sec = makeLayer();
      const dbPath = join(tmpdir(), "lax-sql-outside-write.db");
      const d = sec.evaluate({
        toolName: "sql_query",
        args: { database: dbPath, query: "DELETE FROM t", readonly: false },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/cannot write/i);
    });

    // sql_schema (read-only by nature) against an outside path: blocked.
    it("sql_schema against an outside path: blocked", () => {
      const sec = makeLayer();
      const dbPath = join(tmpdir(), "lax-sql-schema-outside.db");
      const d = sec.evaluate({
        toolName: "sql_schema",
        args: { database: dbPath },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
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

    it("allowed for a dynamic mcp_* tool via http-class resolution (no url arg)", () => {
      // MCP tools (mcp_<server>_<tool>) aren't in TOOLS, but kernelClassForTool
      // resolves the mcp_ prefix to http so they pass the class gate instead of
      // hitting the not-in-registry deny — even without the mcpServer signal.
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "mcp_github_create_issue",
        args: { title: "x" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).not.toMatch(/not in registry/);
    });

    it("SSRF-checks a dynamic mcp_* tool that carries a url arg", () => {
      // If an MCP tool takes a url, the http gate still validates egress.
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "mcp_fetch_get",
        args: { url: "http://169.254.169.254/latest/meta-data/" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });
  });
