/**
 * Windows searches a child's cwd for a bare program name before the PATH, and
 * the server runs children in directories the agent writes. The server turns
 * that search off for itself and its children at the top of its boot
 * (src/index.ts), and the default-deny child env carries the switch to a
 * cmd.exe started under it. The fixture is a renamed node.exe planted as
 * git.exe in the cwd: it answers --version with node's version, not git's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSelfEditChildEnv } from "./self-edit/child-env.js";

const SWITCH = "NoDefaultCurrentDirectoryInExePath";

describe("server boot", () => {
  it("switches the cwd lookup off before it imports or starts anything", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const set = src.indexOf(`process.env.${SWITCH} = "1"`);
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(src.indexOf("await import("));
  });
});

describe.runIf(process.platform === "win32")("a git.exe planted in the cwd", () => {
  let dir = "";
  const saved = process.env[SWITCH];
  const setSwitch = (on: boolean) => {
    if (on) process.env[SWITCH] = "1";
    else delete process.env[SWITCH];
  };
  const withoutSwitch = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== SWITCH.toUpperCase()));

  /** Which git a bare `git --version` in the planted cwd started. */
  function gitThatRan(opts: { shell?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = opts.shell
        ? spawn("git --version", { cwd: dir, shell: true, env: opts.env, windowsHide: true })
        : spawn("git", ["--version"], { cwd: dir, env: opts.env, windowsHide: true });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
      child.on("error", reject);
      child.on("close", () => resolve(/^git version/.test(out) ? "real" : /^v\d+\.\d+\.\d+/.test(out.trim()) ? "planted" : out.trim()));
    });
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cwd-lookup-planted-"));
    copyFileSync(process.execPath, join(dir, "git.exe"));
  });

  afterAll(() => {
    if (saved === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs while the switch is off, without a shell and through cmd.exe", async () => {
    setSwitch(false);
    expect(await gitThatRan()).toBe("planted");
    expect(await gitThatRan({ shell: true })).toBe("planted");
  });

  it("is skipped without a shell once this process has the switch, whatever env the child gets", async () => {
    setSwitch(true);
    expect(await gitThatRan()).toBe("real");
    expect(await gitThatRan({ env: withoutSwitch() })).toBe("real");
  });

  it("is skipped by cmd.exe only when the switch is in cmd.exe's own env", async () => {
    setSwitch(true);
    expect(await gitThatRan({ shell: true })).toBe("real");
    expect(await gitThatRan({ shell: true, env: withoutSwitch() })).toBe("planted");
  });

  it("is skipped by a cmd.exe started under the default-deny child env", async () => {
    setSwitch(true);
    expect(await gitThatRan({ shell: true, env: buildSelfEditChildEnv() })).toBe("real");
  });
});
