/**
 * The opt-in "disposable sandbox" switch, and the shell redirect that must not
 * point at a tool that refuses the same path.
 *
 * Terminal-Bench (nginx-request-logging, 2026-10-19): in unrestricted mode the
 * write/edit tools refused /etc/nginx and /var/www, and the shell gate sent
 * every `sed -i` and heredoc back to those tools. The model went back and forth
 * and gave up. Off by default, the floors stay; on, a throwaway machine can be
 * administered.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFileAccess } from "./file-access.js";
import { evaluateShellCommandAndPaths } from "./shell-path-guard.js";
import { isDisposableSandbox } from "./disposable-sandbox.js";

const WIN = process.platform === "win32";
const SYSTEM_FILE = WIN ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/nginx/nginx.conf";
const OUTSIDE_HOME = WIN ? "C:\\inetpub\\wwwroot\\index.html" : "/var/www/html/index.html";

let dataDir: string;
let workspace: string;
let savedDataDir: string | undefined;

function setSwitch(on: boolean | undefined): void {
  const cfg = on === undefined ? { fileAccessMode: "unrestricted" } : { fileAccessMode: "unrestricted", disposableSandbox: on };
  writeFileSync(join(dataDir, "security.json"), JSON.stringify(cfg));
}

beforeEach(() => {
  savedDataDir = process.env.LAX_DATA_DIR;
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-disposable-")));
  workspace = join(dataDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const write = (mode: "workspace" | "common" | "unrestricted", path: string) =>
  evaluateFileAccess(workspace, mode, () => false, "write", path);

describe("isDisposableSandbox", () => {
  it("is off without a security.json, without the key, and for anything but true", () => {
    expect(isDisposableSandbox()).toBe(false);
    setSwitch(undefined);
    expect(isDisposableSandbox()).toBe(false);
    writeFileSync(join(dataDir, "security.json"), JSON.stringify({ disposableSandbox: "yes" }));
    expect(isDisposableSandbox()).toBe(false);
    writeFileSync(join(dataDir, "security.json"), "{not json");
    expect(isDisposableSandbox()).toBe(false);
    setSwitch(true);
    expect(isDisposableSandbox()).toBe(true);
  });
});

describe("the unrestricted write floors", () => {
  it("stay on by default, and the refusal says how to lift them", () => {
    setSwitch(undefined);
    const sys = write("unrestricted", SYSTEM_FILE);
    expect(sys.allowed).toBe(false);
    expect(sys.reason).toMatch(/system directory/);
    expect(sys.reason).toContain('"disposableSandbox": true');
    const outside = write("unrestricted", OUTSIDE_HOME);
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toMatch(/outside home directory/);
  });

  it("lift on a disposable sandbox, for writes and deletes", () => {
    setSwitch(true);
    expect(write("unrestricted", SYSTEM_FILE).allowed).toBe(true);
    expect(write("unrestricted", OUTSIDE_HOME).allowed).toBe(true);
    expect(evaluateFileAccess(workspace, "unrestricted", () => false, "delete_file", SYSTEM_FILE).allowed).toBe(true);
  });

  it("do not widen a narrower mode: the switch only acts in unrestricted", () => {
    setSwitch(true);
    expect(write("workspace", SYSTEM_FILE).allowed).toBe(false);
    expect(write("common", OUTSIDE_HOME).allowed).toBe(false);
  });

  it("never reach LAX's own protected files", () => {
    setSwitch(true);
    writeFileSync(join(workspace, ".env"), "SECRET=1\n");
    const env = write("unrestricted", join(workspace, ".env"));
    expect(env.allowed).toBe(false);
    expect(env.reason).toMatch(/protected platform file/);
  });
});

describe("a shell edit redirected to the file tools", () => {
  const ctx = () => ({ workspace, fileAccessMode: "unrestricted" as const, allowedPathCheck: () => false, inlineEvalPolicy: "refuse" as const });
  const sedSystem = WIN ? `sed -i "s/a/b/" ${SYSTEM_FILE.replace(/\\/g, "/")}` : `sed -i 's/a/b/' ${SYSTEM_FILE}`;

  it("names the target's real refusal when the file tools refuse it too, instead of a dead-end redirect", () => {
    setSwitch(undefined);
    const d = evaluateShellCommandAndPaths(sedSystem, ctx());
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/write\/edit tools refuse that path too/);
    expect(d.reason).not.toMatch(/Use the edit tool/);
  });

  // On a disposable sandbox the shell's structural rules stand down everywhere
  // but Windows (shell-policy.ts structuralRulesApply), so off Windows the edit
  // simply runs; on Windows they still apply, and the redirect now leads to a
  // tool that takes the path.
  it.runIf(WIN)("keeps the redirect when the file tools can take the path", () => {
    setSwitch(true);
    expect(evaluateShellCommandAndPaths(sedSystem, ctx()).reason).toMatch(/Use the edit tool/);
  });

  it.runIf(!WIN)("lets the shell edit a system file itself on a disposable sandbox", () => {
    setSwitch(true);
    expect(evaluateShellCommandAndPaths(sedSystem, ctx()).allowed).toBe(true);
  });

  it("redirects a shell edit the file tools can take, on any machine", () => {
    setSwitch(undefined);
    const inWorkspace = evaluateShellCommandAndPaths("sed -i 's/a/b/' notes.txt", ctx());
    expect(inWorkspace.reason).toMatch(/Use the edit tool/);
  });
});
