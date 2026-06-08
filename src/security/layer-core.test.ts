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
    // Shell-class non-bash tools (process_start, ari_shell) now route their
    // command through the SAME evaluateShellCommand scan bash gets, instead of
    // an unconditional allow — closing the structured/background-shell bypass.
    it("process_start: a benign command is allowed", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "process_start",
        args: { command: "node script.js" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
    });

    it("process_start: a denylisted command is blocked (no longer auto-allowed)", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "process_start",
        args: { command: "rm -rf /tmp/x" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(false);
    });

    it("shell-class tool with no command arg falls through to kernel/tool gate", () => {
      const sec = makeLayer();
      const d = sec.evaluate({
        toolName: "process_status",
        args: { session_id: "px-abc" },
        sessionId: "t",
      });
      expect(d.allowed).toBe(true);
      expect(d.reason).toMatch(/shell-class tool/);
    });
  });

  // ── 9: database-class ──

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
  });
});

// The platform-source write guard protects <repoRoot>/src and
// <repoRoot>/public (the LAX platform itself) while leaving user apps under
// workspace/ free to use a src/ convention (Astro, Vite, Next, …). Before the
// anchor fix a bare "/src/" substring blocked every framework scaffold built
// in the workspace.
describe("platform-source write guard (anchored to repo root)", () => {
  const ws = resolve(WORKSPACE);

  it("allows writing src/ inside a workspace app (Astro scaffold)", () => {
    const path = resolve(ws, "my-site/src/pages/index.astro");
    const d = evaluateFileAccess(ws, "common", () => false, "write", path);
    expect(d.allowed).toBe(true);
  });

  it("allows writing public/ inside a workspace app", () => {
    const path = resolve(ws, "my-site/public/favicon.ico");
    const d = evaluateFileAccess(ws, "common", () => false, "write", path);
    expect(d.allowed).toBe(true);
  });

  it("blocks writing the platform's own src/ even in unrestricted mode", () => {
    const path = resolve(ws, "../src/server/routes.ts");
    const d = evaluateFileAccess(ws, "unrestricted", () => false, "write", path);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/platform files/i);
  });

  it("blocks writing the platform's own public/ even in unrestricted mode", () => {
    const path = resolve(ws, "../public/app.html");
    const d = evaluateFileAccess(ws, "unrestricted", () => false, "write", path);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/platform files/i);
  });

  it("allows a workspace-app src/ write in unrestricted mode too", () => {
    const path = resolve(ws, "my-site/src/components/Hero.tsx");
    const d = evaluateFileAccess(ws, "unrestricted", () => false, "write", path);
    expect(d.allowed).toBe(true);
  });
});

// Egress mode is `permissive` by default — agent can surf the public web
// while SSRF/private-IP/cloud-metadata blocks remain in force. The previous
// deny-by-default model broke autonomous web research without adding real
// safety (allowlist file ≠ exfiltration defense). Strict mode is preserved
// for users who want it; secret-bearing requests are gated at the tool
// layer via the trusted-destinations check in web-tools.ts.
describe("egress mode semantics", () => {
  // Each test below isolates LAX_DATA_DIR to a fresh directory; the
  // outer suite's beforeAll fixture must not bleed in.
  function withLaxDir<T>(setup: (dir: string) => void, run: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), "egress-mode-"));
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

  it("default permissive: missing config → public host allowed", () => {
    withLaxDir(
      () => { /* no security.json, no allowlist */ },
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://en.wikipedia.org/wiki/Anything" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(true);
      },
    );
  });

  it("default permissive: SSRF still blocks private IPs", () => {
    withLaxDir(
      () => {},
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "http_request",
          args: { url: "http://169.254.169.254/latest/meta-data/" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/metadata|private|reserved/i);
      },
    );
  });

  it("strict mode: missing allowlist → deny with setup hint", () => {
    withLaxDir(
      (dir) => writeFileSync(
        join(dir, "security.json"),
        JSON.stringify({ egressMode: "strict" }),
        "utf-8",
      ),
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/strict.*no allowlist|egress-allowlist\.json/i);
      },
    );
  });

  it("strict mode: only allowlisted hosts pass", () => {
    withLaxDir(
      (dir) => {
        writeFileSync(
          join(dir, "security.json"),
          JSON.stringify({ egressMode: "strict" }),
          "utf-8",
        );
        writeFileSync(
          join(dir, "egress-allowlist.json"),
          JSON.stringify(["api.anthropic.com"]),
          "utf-8",
        );
      },
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
        expect(denied.reason).toMatch(/not in the egress allowlist/i);
      },
    );
  });

  it("evaluateWebFetch direct call: permissive default → public host allowed", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "https://example.com");
    expect(d.allowed).toBe(true);
  });

  it("evaluateWebFetch strict + missing → deny with setup hint", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "https://example.com", "strict");
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/strict.*no allowlist/i);
  });

  it("evaluateWebFetch: loopback host + allowlisted local service port → allowed", () => {
    const ports = new Set(["47831"]);
    for (const url of ["http://127.0.0.1:47831/health", "http://localhost:47831/health"]) {
      const d = evaluateWebFetch(new Set(), false, "7007", url, "permissive", ports);
      expect(d.allowed).toBe(true);
      expect(d.reason).toBe("Allowed local service");
    }
  });

  it("evaluateWebFetch: loopback host + port NOT in allowlist → still blocked", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "http://127.0.0.1:9999/health", "permissive", new Set(["47831"]));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/private\/reserved/i);
  });

  it("evaluateWebFetch: loopback block on non-allowlisted port carries a localServicePorts recovery hint", () => {
    // Right-time hint for the original "can't verify my bridge" failure — the
    // model should learn it can allowlist its own service's port.
    for (const url of ["http://127.0.0.1:9999/health", "http://[::1]:9999/health", "http://localhost:9999/health"]) {
      const d = evaluateWebFetch(new Set(), false, "7007", url, "permissive", new Set(["47831"]));
      expect(d.allowed).toBe(false);
      expect(typeof d.recovery).toBe("string");
      expect(d.recovery).toMatch(/localServicePorts/);
    }
  });

  it("evaluateWebFetch: public host unaffected by local service ports", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "https://example.com", "permissive", new Set(["47831"]));
    expect(d.allowed).toBe(true);
  });

  it("evaluateWebFetch: non-loopback private IP + allowlisted port → still blocked", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "http://10.0.0.5:47831/health", "permissive", new Set(["47831"]));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/private\/reserved/i);
  });

  it("SecurityLayer: localServicePorts from security.json gates loopback health-checks", () => {
    withLaxDir(
      (dir) => {
        writeFileSync(join(dir, "security.json"), JSON.stringify({ localServicePorts: [47831, "5050"] }), "utf-8");
      },
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const allowed = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "http://127.0.0.1:47831/health" },
          sessionId: "t",
        });
        expect(allowed.allowed).toBe(true);
        expect(allowed.reason).toBe("Allowed local service");
        const blocked = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "http://127.0.0.1:9999/health" },
          sessionId: "t",
        });
        expect(blocked.allowed).toBe(false);
      },
    );
  });

  it("permissive + populated allowlist: any public host still allowed (allowlist gates secrets, not surfing)", () => {
    withLaxDir(
      (dir) => writeFileSync(
        join(dir, "egress-allowlist.json"),
        JSON.stringify(["api.anthropic.com"]),
        "utf-8",
      ),
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const listed = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://api.anthropic.com/v1/messages" },
          sessionId: "t",
        });
        expect(listed.allowed).toBe(true);
        const unlisted = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(unlisted.allowed).toBe(true);
      },
    );
  });
});
