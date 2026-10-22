/**
 * The DPAPI master key crosses into PowerShell only on the child's standard
 * input and output. It never appears in the command line, the environment, a
 * script file or a temp file — the places PowerShell ScriptBlock logging, AMSI,
 * Defender sample submission and any same-user process can see (red team
 * round 2, S-M3; this replaced the SV-6 check that the temp files were 0600,
 * which is a no-op on Windows).
 *
 * A fake `powershell.exe` first on PATH records exactly what crossed the
 * process boundary: its arguments, the environment variable carrying the
 * sealed file's path, its stdin, and every file in the data dir while it runs.
 * POSIX-only (sh stub). The real seal and unseal are exercised on Windows by
 * src/keychain-dpapi.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { dpapiStore, dpapiRetrieve } from "../src/keychain.js";

const posixOnly = it.skipIf(process.platform === "win32");

// Logs argv, the sealed-file path from the environment, stdin, and the data
// dir's listing to $STUB_LOG. An unseal script (it calls Unprotect) answers
// with $KEY_B64 on stdout; a seal script writes a placeholder sealed file.
const STUB = `#!/bin/sh
{
  for a in "$@"; do printf 'arg %s\\n' "$a"; done
  printf 'path %s\\n' "$LAX_DPAPI_PATH"
  printf 'stdin %s\\n' "$(cat)"
  printf 'files %s\\n' "$(ls "$DATA_DIR" | tr '\\n' ' ')"
} >> "$STUB_LOG"
case "$*" in
  *Unprotect*) printf '%s' "$KEY_B64" ;;
  *Protect*) printf 'sealed' > "$LAX_DPAPI_PATH" ;;
esac
exit 0
`;

describe("keychain DPAPI transport (S-M3)", () => {
  let dir: string;
  let dataDir: string;
  let logPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-dpapi-transport-"));
    dataDir = mkdtempSync(join(tmpdir(), "lax-dpapi-data-"));
    logPath = join(dir, "stub.log");
    const stubPath = join(dir, "powershell.exe");
    writeFileSync(stubPath, STUB);
    chmodSync(stubPath, 0o755);
    for (const k of ["PATH", "STUB_LOG", "KEY_B64", "DATA_DIR"]) saved[k] = process.env[k];
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    process.env.STUB_LOG = logPath;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const lines = (prefix: string) => readFileSync(logPath, "utf-8").split("\n").filter((l) => l.startsWith(prefix + " ")).map((l) => l.slice(prefix.length + 1));

  posixOnly("sealing sends the key on stdin only, and nothing but the sealed file lands in the data dir", () => {
    const key = randomBytes(32);
    const sealed = join(dataDir, "master.dpapi");
    dpapiStore(key, sealed);
    const b64 = key.toString("base64");
    expect(lines("stdin")).toEqual([b64]);
    expect(lines("arg").join(" ")).not.toContain(b64);
    expect(lines("path")).toEqual([sealed]);
    expect(lines("files")).toEqual([""]);
    expect(readFileSync(sealed, "utf-8")).toBe("sealed");
  });

  posixOnly("unsealing returns the key on stdout: nothing on stdin, and no temp file while it runs", () => {
    const key = randomBytes(32);
    process.env.KEY_B64 = key.toString("base64");
    const sealed = join(dataDir, "master.dpapi");
    writeFileSync(sealed, "sealed");
    expect(dpapiRetrieve(sealed).equals(key)).toBe(true);
    expect(lines("stdin")).toEqual([""]);
    expect(lines("path")).toEqual([sealed]);
    expect(lines("files")).toEqual(["master.dpapi "]);
  });

  posixOnly("the sealed file's path reaches the script as data, so a quote in it cannot change the script", () => {
    const sealed = join(dataDir, "o'brien.dpapi");
    dpapiStore(randomBytes(32), sealed);
    expect(lines("path")).toEqual([sealed]);
    expect(lines("arg").join(" ")).not.toContain("o'brien");
  });
});
