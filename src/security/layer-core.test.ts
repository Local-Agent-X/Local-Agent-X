import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SecurityLayer } from "./layer-core.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";
import { evaluateWebFetch } from "./network-policy.js";

// All tests build a SecurityLayer with an explicit fileAccessMode so the
// constructor doesn't read ~/.lax/security.json and produce host-dependent
// results.
const WORKSPACE = "./workspace";

// Isolated LAX_DATA_DIR for the main suite, populated with a known egress
// allowlist so the deny-by-default semantics don't make every "public URL
// allowed" assertion depend on the dev's ~/.lax/egress-allowlist.json.
let savedLaxDir: string | undefined;
let suiteLaxDir: string;

beforeAll(() => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  suiteLaxDir = mkdtempSync(join(tmpdir(), "layer-core-test-"));
  process.env.LAX_DATA_DIR = suiteLaxDir;
  writeFileSync(
    join(suiteLaxDir, "egress-allowlist.json"),
    JSON.stringify(["api.github.com", "example.com"]),
    "utf-8",
  );
});

afterAll(() => {
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedLaxDir;
  rmSync(suiteLaxDir, { recursive: true, force: true });
});

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

    it("web_fetch: public URL allowed (host on suite allowlist)", () => {
      const sec = makeLayer();
      // The suite fixture allowlists api.github.com — direct evaluateWebFetch
      // with the same inputs must agree.
      const expected = evaluateWebFetch(
        new Set(["api.github.com"]),
        true,
        "7007",
        "https://api.github.com",
      );
      const d = sec.evaluate({
        toolName: "web_fetch",
        args: { url: "https://api.github.com" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(expected.allowed);
      expect(d.allowed).toBe(true);
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

// Regression: previously a missing ~/.lax/egress-allowlist.json was treated
// as "no restrictions" — silent fail-open that made the advertised
// allowlist a no-op on every default install. The fix denies by default
// and points the user at the config path.
describe("egress allowlist deny-by-default when missing", () => {
  // Each test below isolates LAX_DATA_DIR to a fresh directory; the
  // outer suite's beforeAll fixture must not bleed in.
  function withLaxDir<T>(setup: (dir: string) => void, run: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), "no-allowlist-"));
    const prev = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dir;
    try {
      setup(dir);
      return run();
    } finally {
      if (prev === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("missing allowlist file: SecurityLayer denies web_fetch to arbitrary public host", () => {
    withLaxDir(
      () => { /* leave the dir empty — no egress-allowlist.json */ },
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/no egress allowlist configured|egress-allowlist\.json/i);
      },
    );
  });

  it("missing allowlist file: SecurityLayer denies http_request similarly", () => {
    withLaxDir(
      () => { /* no file */ },
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "http_request",
          args: { url: "https://attacker.example" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(false);
      },
    );
  });

  it("evaluateWebFetch direct call: not-configured → deny with setup hint", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "https://example.com");
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no egress allowlist configured/i);
  });

  it("explicit empty [] is honored: enforce → deny everything", () => {
    withLaxDir(
      (dir) => writeFileSync(join(dir, "egress-allowlist.json"), "[]", "utf-8"),
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(false);
        // Different error message from the missing-file case — proves the
        // configured flag was loaded.
        expect(d.reason).toMatch(/not in the egress allowlist/i);
      },
    );
  });

  it("populated allowlist: only listed host allowed", () => {
    withLaxDir(
      (dir) => writeFileSync(
        join(dir, "egress-allowlist.json"),
        JSON.stringify(["api.anthropic.com"]),
        "utf-8",
      ),
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const allowed = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://api.anthropic.com/v1/messages" },
          sessionId: "t",
        });
        expect(allowed.allowed).toBe(true);
        const denied = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(denied.allowed).toBe(false);
      },
    );
  });
});
