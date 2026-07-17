import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateFileAccess } from "./file-access.js";
import { SecurityLayer } from "./layer-core.js";
import { evaluateWebFetch } from "./network-policy.js";
import { evaluateShellCommand } from "./shell-policy.js";

const WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-ws-")));
const WORKSPACE = join(WORKSPACE_ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
afterAll(() => rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));
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
      // bash passes through two layers now — command-shape vetting
      // (evaluateShellCommand) then file-access confinement (the path guard).
      // A path-free safe command clears both.
      expect(evaluateShellCommand("ls").allowed).toBe(true);
      const d = sec.evaluate({ toolName: "bash", args: { command: "ls" }, sessionId: "t" });
      expect(d.allowed).toBe(true);
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

  // ── R4-15: /dev/tcp reverse-shell / exfil (spaced AND glued redirect) ──
});
