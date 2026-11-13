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
import { homedir, tmpdir } from "node:os";
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

  // A recorded chat (2026-11-01): the edit was to a file the edit tool takes,
  // and a later command in the chain read a container path. The refusal named
  // the container path as the edit's target and said the file tools were no
  // way around it.
  it("judges only what the edit writes, not a path the command reads", () => {
    setSwitch(undefined);
    const outside = OUTSIDE_HOME.replace(/\\/g, "/");
    const chained = evaluateShellCommandAndPaths(`sed -i 's/a/b/' notes.txt; psql -q -f ${outside}`, ctx());
    expect(chained.allowed).toBe(false);
    expect(chained.reason).toMatch(/Use the edit tool/);
    expect(chained.reason).not.toMatch(/refuse that path too/);
  });

  it("a sed script that looks like a path is not the edit's target", () => {
    setSwitch(undefined);
    const d = evaluateShellCommandAndPaths("sed -i /obsolete/d notes.txt", ctx());
    expect(d.reason).toMatch(/Use the edit tool/);
  });

  it("still names the real refusal when the script comes by -e", () => {
    setSwitch(undefined);
    const d = evaluateShellCommandAndPaths(`sed -i -e 's/a/b/' ${SYSTEM_FILE.replace(/\\/g, "/")}`, ctx());
    expect(d.reason).toMatch(/write\/edit tools refuse that path too/);
  });

  // Found 2026-11-12: `cat > <system path> <<'EOF'` passed the security layer
  // in unrestricted mode while `write` to the same path was refused. The shell
  // gets the file tools' floors now, in every form a write can take.
  it("refuses a shell write to a path the file tools refuse, in every write form", () => {
    setSwitch(undefined);
    const sys = SYSTEM_FILE.replace(/\\/g, "/");
    const outside = OUTSIDE_HOME.replace(/\\/g, "/");
    for (const command of [
      `cat > ${sys} <<'EOF'\nx\nEOF`,
      `echo x > ${sys}`,
      `echo x >> ${outside}`,
      `printf x | tee ${sys}`,
      `cp notes.txt ${outside}`,
      `cd repo && echo x >${sys}`,
    ]) {
      const d = evaluateShellCommandAndPaths(command, ctx());
      expect(d.allowed, command).toBe(false);
      expect(d.reason, command).toMatch(/write\/edit tools refuse/);
    }
  });

  it("still lets the shell write where the file tools may: the workspace, home, temp and /dev/null", () => {
    setSwitch(undefined);
    // A real machine's TEMP is under the user's home (Windows: AppData\Local\Temp);
    // the test setup moves HOME to a throwaway folder, so put TEMP back under it.
    const home = homedir();
    const temp = join(home, "AppData", "Local", "Temp");
    mkdirSync(temp, { recursive: true });
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
    try {
      const fwd = (p: string) => p.replace(/\\/g, "/");
      for (const command of [
        `echo x > ${fwd(join(workspace, "out.txt"))}`,
        "echo x > out.txt",
        `echo x > ${fwd(join(home, "notes.md"))}`,
        `echo x > ${fwd(join(temp, "lax-probe.mjs"))}`,
        "node build.js > /dev/null 2>&1",
        ...(WIN ? ["cat > /tmp/lax-probe.mjs <<'EOF'\nconsole.log(1)\nEOF"] : []),
      ]) {
        const d = evaluateShellCommandAndPaths(command, ctx());
        expect(d.reason, command).not.toMatch(/write\/edit tools refuse/);
      }
    } finally {
      Object.assign(process.env, saved);
    }
  });

  // Recorded commands (2026-11) the first cut of the floor misread as writes:
  // a `>` inside quotes, a subshell's closing paren, and git's own config.
  it("does not read a quoted '>', a subshell's paren or git's own config as a refused write", () => {
    setSwitch(undefined);
    for (const command of [
      `sed -n '105p' a.test.tsx | sed -E 's/[A-Za-z0-9+\\/_-]{20,}/<LONG>/g'`,
      `node -e "const p=require('playwright');console.log(Object.keys(p.devices).filter(d=>/iPhone 1[34]/.test(d)).join(' | '))"`,
      `grep -oE '<nav[^>]*main-navigation[^>]*>' index.html | head -1`,
      `cd apps/x && (git log --oneline -5 2>/dev/null); ls`,
      `echo "n=$(ls docs 2>/dev/null | wc -l)"`,
      `node -e "const re=/a=\\"(\\d)\\"[^>]*>\\s*<b/g; console.log(re)"`,
      `grep -oiE "url\\(['\\"]?(assets/[^)'\\"]+)" a.css 2>/dev/null | sed -E "s/url\\(['\\"]?//"`,
      `git -C "C:/Users/someone/CRM" remote set-url origin https://example.com/a.git`,
    ]) {
      const d = evaluateShellCommandAndPaths(command, ctx());
      expect(d.reason, command).not.toMatch(/write\/edit tools refuse/);
    }
  });

  it("still refuses a real redirect beside quoted text, and a subshell's real write", () => {
    setSwitch(undefined);
    const outside = OUTSIDE_HOME.replace(/\\/g, "/");
    for (const command of [
      `echo "a > b" > ${outside}`,
      `(echo x >${outside})`,
      `echo x > "${outside}"`,
    ]) {
      const d = evaluateShellCommandAndPaths(command, ctx());
      expect(d.allowed, command).toBe(false);
      expect(d.reason, command).toMatch(/write\/edit tools refuse/);
    }
  });

  it("lifts the floor on a disposable sandbox, as it does for the file tools", () => {
    setSwitch(true);
    const d = evaluateShellCommandAndPaths(`echo x > ${OUTSIDE_HOME.replace(/\\/g, "/")}`, ctx());
    expect(d.allowed).toBe(true);
  });

  it("still names the real refusal for a heredoc redirected to a refused path", () => {
    setSwitch(undefined);
    const d = evaluateShellCommandAndPaths(`cat <<'EOF' > ${SYSTEM_FILE.replace(/\\/g, "/")}\nx\nEOF`, ctx());
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/write\/edit tools refuse that path too/);
  });
});
