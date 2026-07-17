import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CAPABILITY_CLASS_MEMBERS } from "../../tool-registry.js";
import { SecurityLayer } from "./layer-core.js";
import { evaluateShellCommandAndPaths } from "./shell-path-guard.js";

const WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-ws-")));
const WORKSPACE = join(WORKSPACE_ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
afterAll(() => rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));


describe("cron shell context restriction", () => {
  it("categorically denies every shell capability member", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    for (const toolName of CAPABILITY_CLASS_MEMBERS.shell) {
      const decision = sec.evaluate({ toolName, args: { command: "echo ok" }, sessionId: "cron-test", callContext: "cron" });
      expect(decision.allowed, toolName).toBe(false);
      expect(decision.reason).toContain("cron context");
    }
  });
});

describe("bash obeys the file-access mode (shell path guard)", () => {
  const bash = (sec: SecurityLayer, command: string) =>
    sec.evaluate({ toolName: "bash", args: { command }, sessionId: "t" });

  it("workspace mode: reading an absolute path outside the project is blocked", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    expect(bash(sec, "cat /etc/passwd").allowed).toBe(false);
  });

  it("workspace mode: reading a Windows path outside the project is blocked", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    expect(bash(sec, 'type "C:\\Users\\alice\\Documents\\2024 May order.xlsx"').allowed).toBe(false);
  });

  it("workspace mode: a redirect (write) target outside the workspace is blocked", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    expect(bash(sec, "echo secret > ~/exfil.txt").allowed).toBe(false);
  });

  it("workspace mode: a `..` climb out of the project is blocked", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    expect(bash(sec, "cat ../../../../etc/shadow").allowed).toBe(false);
  });

  it("workspace mode: ordinary in-project commands still run", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    for (const cmd of ["git status", "ls -la", "npm test", "cat package.json", "grep foo src/index.ts"]) {
      expect(bash(sec, cmd).allowed, cmd).toBe(true);
    }
  });

  it("workspace mode: redirect to /dev/null is not mistaken for an escape", () => {
    const sec = new SecurityLayer(WORKSPACE, "workspace");
    expect(bash(sec, "echo hi > /dev/null").allowed).toBe(true);
  });

  it("common mode: reading ~/Documents is allowed, /etc is not", () => {
    const sec = new SecurityLayer(WORKSPACE, "common");
    expect(bash(sec, "cat ~/Documents/notes.txt").allowed).toBe(true);
    expect(bash(sec, "cat /etc/passwd").allowed).toBe(false);
  });

  it("unrestricted mode: bash reaches anywhere (guard is a no-op)", () => {
    const sec = new SecurityLayer(WORKSPACE, "unrestricted");
    expect(bash(sec, "cat /etc/hosts").allowed).toBe(true);
  });

  it("the command-shape vetting still runs first (obfuscation blocked regardless of mode)", () => {
    const sec = new SecurityLayer(WORKSPACE, "unrestricted");
    expect(bash(sec, "echo $'\\162\\155'").allowed).toBe(false);
  });
});


describe("bash self-brick guard — protected engine source", () => {
  // PLATFORM_ROOT (config-loader) is <repo>; this test file sits at
  // <repo>/src/security, so the engine's absolute paths derive from here.
  const REPO = resolve(import.meta.dirname, "..", "..");
  const eng = (rel: string) => join(REPO, rel);
  // Unrestricted on purpose: the guard must hold even at maximum access.
  const ctx = { workspace: WORKSPACE, fileAccessMode: "unrestricted" as const, allowedPathCheck: () => true };
  const run = (cmd: string) => evaluateShellCommandAndPaths(cmd, ctx);

  it("BLOCKS shell delete/overwrite of the engine core (the self-brick vectors)", () => {
    for (const cmd of [
      `rm -rf ${eng("src/security")}`,
      `rm -f ${eng("src/index.ts")}`,
      `echo x > ${eng("src/server/bootstrap-services.ts")}`,
      `mv /tmp/evil.ts ${eng("src/canonical-loop/turn-loop.ts")}`,
      `truncate -s0 ${eng("config/protected-files.json")}`,
    ]) {
      expect(run(cmd).allowed, cmd).toBe(false);
    }
  });

  it("ALLOWS reading engine source and copying it OUT (source read, non-engine dest)", () => {
    expect(run(`cat ${eng("src/security/file-access.ts")}`).allowed).toBe(true);
    expect(run(`cp ${eng("src/index.ts")} /tmp/backup.ts`).allowed).toBe(true);
  });

  it("does NOT false-block a user app whose files mirror engine paths", () => {
    // A workspace app legitimately has src/index.ts — deleting it via its real
    // (workspace) path must be allowed; only the ENGINE tree is protected.
    expect(run(`rm -rf ${join(WORKSPACE, "apps", "myapp", "src")}`).allowed).toBe(true);
    expect(run(`rm -f ${join(WORKSPACE, "apps", "myapp", "src", "index.ts")}`).allowed).toBe(true);
  });
});
