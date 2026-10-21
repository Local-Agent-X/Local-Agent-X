// The DPAPI-sealed master key crosses into PowerShell only through the
// child's standard input and output. The previous round trip put the plaintext
// key in a .ps1 script body (store) and a temp .b64 file (retrieve), where
// ScriptBlock logging, AMSI, Defender sample submission and any process
// running as the user could see it; 0600 is a no-op on Windows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync as realExecFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const calls = vi.hoisted(() => [] as Array<{ args: string[]; options: Record<string, unknown> }>);
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ args, options });
      return actual.execFileSync(file, args, options as never);
    },
  };
});

const { dpapiStore, dpapiRetrieve } = await import("./keychain.js");
const onWindows = process.platform === "win32";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-dpapi-")); calls.length = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!onWindows)("DPAPI master-key round trip", () => {
  it("seals and unseals the key, leaving only the sealed file on disk", () => {
    const key = randomBytes(32);
    const sealed = join(dir, "master.dpapi");
    dpapiStore(key, sealed);
    expect(readdirSync(dir)).toEqual(["master.dpapi"]);
    expect(readFileSync(sealed).includes(key)).toBe(false);
    expect(dpapiRetrieve(sealed).equals(key)).toBe(true);
    expect(readdirSync(dir)).toEqual(["master.dpapi"]);
  });

  it("the key travels on stdin and stdout only: never in the script, the arguments or the environment", () => {
    const key = randomBytes(32);
    const b64 = key.toString("base64");
    const sealed = join(dir, "master.dpapi");
    dpapiStore(key, sealed);
    dpapiRetrieve(sealed);
    expect(calls).toHaveLength(2);
    for (const { args, options } of calls) {
      expect(args.join(" ")).not.toContain(b64);
      expect(JSON.stringify(options.env)).not.toContain(b64);
    }
    expect(calls[0].options.input).toBe(b64);
    expect(calls[1].options.input).toBeUndefined();
  });

  it("a path with a quote in it reaches the script as data, not as script text", () => {
    const key = randomBytes(32);
    const sealed = join(dir, "o'brien.dpapi");
    dpapiStore(key, sealed);
    expect(existsSync(sealed)).toBe(true);
    expect(dpapiRetrieve(sealed).equals(key)).toBe(true);
    for (const { args } of calls) expect(args.join(" ")).not.toContain("o'brien");
  });

  it("a sealed file another user or machine could not open fails loudly instead of returning an empty key", () => {
    const sealed = join(dir, "master.dpapi");
    realExecFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[IO.File]::WriteAllBytes('${sealed.replace(/'/g, "''")}', [byte[]](1..64))`], { windowsHide: true });
    expect(() => dpapiRetrieve(sealed)).toThrow();
  });
});
