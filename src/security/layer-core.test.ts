import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { SecurityLayer } from "./layer-core.js";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommand } from "./shell-policy.js";
import { evaluateWebFetch } from "./network-policy.js";
import { TOOL_PATH_ARGS } from "../tool-registry.js";

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

// Relocated-workspace junction: the packaged app moves the workspace into
// ~/Documents and bridges <cwd>/workspace → there with a directory junction
// (symlink on POSIX). An agent reading an app file via the bridged path is
// lexically "outside" config.workspace but physically inside it. The
// containment check MUST follow the junction (realpath every segment) or every
// such read is wrongly blocked — the bug that surfaced as "BLOCKED by security:
// cannot read files outside project and user directories" on an app's own file.
describe("relocated-workspace junction is transparent to containment", () => {
  let realWs: string;
  let bridge: string; // a link that points INTO realWs, sitting elsewhere
  let linkable = true;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "ws-junction-"));
    realWs = join(base, "real", "workspace");
    mkdirSync(join(realWs, "apps", "demo"), { recursive: true });
    writeFileSync(join(realWs, "apps", "demo", "index.html"), "<h1>hi</h1>", "utf-8");
    bridge = join(base, "bridge-workspace");
    try {
      // "junction" on Windows mirrors the real ensureWorkspaceLink; "dir" symlink elsewhere.
      symlinkSync(realWs, bridge, process.platform === "win32" ? "junction" : "dir");
    } catch {
      linkable = false; // unprivileged POSIX without symlink rights — skip assertions
    }
  });

  it("allows a read through the junction into the real workspace", () => {
    if (!linkable) return;
    // config.workspace is the REAL location; the agent's path traverses the bridge.
    const viaBridge = join(bridge, "apps", "demo", "index.html");
    const d = evaluateFileAccess(realWs, "common", () => false, "read", viaBridge);
    expect(d.allowed).toBe(true);
  });

  it("still blocks a read that genuinely escapes the workspace", () => {
    if (!linkable) return;
    const outside = join(bridge, "..", "..", "elsewhere", "secret.txt");
    const d = evaluateFileAccess(realWs, "common", () => false, "read", outside);
    expect(d.allowed).toBe(false);
  });
});

// A relative agent path must resolve the SAME way the file tool that opens it
// does (resolveAgentPath): anchored to the project root (workspace parent), not
// process.cwd(). This is what lets a relocated-workspace install read its own
// app files via the agent's "workspace/apps/<id>/..." convention without a
// false "outside project and user directories" block.
describe("relative agent paths anchor to the project root, not cwd", () => {
  const ws = resolve(WORKSPACE); // ends in /workspace, so parent is the project root

  it("allows a workspace-prefixed relative read (lands inside the workspace)", () => {
    const d = evaluateFileAccess(ws, "common", () => false, "read", "workspace/apps/demo/index.html");
    expect(d.allowed).toBe(true);
  });

  it("blocks a relative path that climbs out of the project root", () => {
    const d = evaluateFileAccess(ws, "workspace", () => false, "read", "../../../../../../etc/shadow");
    expect(d.allowed).toBe(false);
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

// The office/vision tools (spreadsheet/document/presentation/pdf/ocr/image)
// are kernel:"internal" and historically skipped file-access confinement
// entirely — an agent in "workspace only" mode could spreadsheet_read ANY xlsx
// on disk (the breach: reading ~/Documents/2024 May order.xlsx outside the
// workspace). Each now declares its caller path in TOOL_PATH_ARGS and is gated
// through the SAME evaluateFileAccess boundary as read/write. These tests pin
// that workspace-only is a HARD boundary for every declared file sink.
describe("structured-document file-access confinement (TOOL_PATH_ARGS)", () => {
  const ws = resolve(WORKSPACE);
  // An absolute path outside the project root AND outside ~/.lax — blocked in
  // workspace mode. The filename mirrors the real breach report. Anchored to
  // tmpdir (not the suite's LAX dir, which is only set in beforeAll).
  const OUTDIR = resolve(tmpdir(), "lax-confine-test");
  const OUTSIDE = resolve(OUTDIR, "2024 May order.xlsx");
  const INSIDE = resolve(ws, "data.xlsx");

  it("workspace mode: spreadsheet_read OUTSIDE the project is blocked (the breach)", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({ toolName: "spreadsheet_read", args: { file_path: OUTSIDE }, sessionId: "t" });
    expect(d.allowed).toBe(false);
  });

  it("workspace mode: spreadsheet_read INSIDE the workspace is still allowed", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({ toolName: "spreadsheet_read", args: { file_path: INSIDE }, sessionId: "t" });
    expect(d.allowed).toBe(true);
  });

  it("spreadsheet_read verdict == evaluateFileAccess(read) — same gate, not a parallel one", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const expected = evaluateFileAccess(ws, "workspace", () => false, "read", OUTSIDE);
    const d = sec.evaluate({ toolName: "spreadsheet_read", args: { file_path: OUTSIDE }, sessionId: "t" });
    expect(d.allowed).toBe(expected.allowed);
    expect(d.reason).toBe(expected.reason);
  });

  it("workspace mode: document_create WRITE outside the workspace is blocked", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({
      toolName: "document_create",
      args: { file_path: resolve(OUTDIR, "out.docx"), content: "x" },
      sessionId: "t",
    });
    expect(d.allowed).toBe(false);
  });

  it("pdf_merge: an out-of-bounds member of the files[] JSON array blocks the call", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    const d = sec.evaluate({
      toolName: "pdf_merge",
      args: { files: JSON.stringify([resolve(ws, "a.pdf"), OUTSIDE]), output_path: resolve(ws, "merged.pdf") },
      sessionId: "t",
    });
    expect(d.allowed).toBe(false);
  });

  it("ocr / view_image (path arg) are confined outside the workspace", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    for (const toolName of ["ocr", "view_image"]) {
      const d = sec.evaluate({ toolName, args: { path: resolve(OUTDIR, "img.png") }, sessionId: "t" });
      expect(d.allowed, toolName).toBe(false);
    }
  });

  // COVERAGE: no declared file sink may bypass workspace confinement. For every
  // tool in TOOL_PATH_ARGS, an out-of-bounds absolute path on EACH declared arg
  // must be blocked in workspace mode. Fails the build the moment a tool
  // declares a path arg the gate doesn't actually enforce.
  it("every TOOL_PATH_ARGS arg blocks an out-of-bounds path in workspace mode", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    for (const [toolName, specs] of Object.entries(TOOL_PATH_ARGS)) {
      for (const spec of specs) {
        const val = spec.json ? JSON.stringify([OUTSIDE]) : OUTSIDE;
        const d = sec.evaluate({ toolName, args: { [spec.arg]: val }, sessionId: "t" });
        expect(d.allowed, `${toolName}.${spec.arg} must be confined`).toBe(false);
      }
    }
  });

  // Guard against silent regression: the known office/vision sinks must stay
  // declared. Removing a declaration (re-opening the bypass) fails here.
  it("known office/vision file sinks are declared in TOOL_PATH_ARGS", () => {
    for (const t of [
      "spreadsheet_read", "spreadsheet_write", "spreadsheet_edit", "spreadsheet_query",
      "document_create", "document_read", "document_edit", "document_template",
      "presentation_create", "presentation_add_slide", "presentation_from_outline",
      "pdf_read", "pdf_create", "pdf_merge", "pdf_extract_tables",
      "ocr", "view_image", "send_video",
    ]) {
      expect(TOOL_PATH_ARGS[t], `${t} must declare pathArgs`).toBeTruthy();
    }
  });
});
