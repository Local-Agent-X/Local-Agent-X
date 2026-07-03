/**
 * SV-6 regression: DPAPI temp files must be owner-only (0o600).
 *
 * dpapiStore writes a .ps1 that embeds the base64 of the PLAINTEXT 32-byte
 * master key; dpapiRetrieve writes a second .ps1 plus a .b64 output file
 * into which PowerShell writes the DECRYPTED key. Pre-fix, all of these
 * were writeFileSync'd with no mode (and the .b64 was created by
 * PowerShell itself), so between write and unlink the master key sat on
 * disk at default-umask perms (typically 0o644) — readable by any
 * same-user process, unlike every other secret file in the repo.
 *
 * The fix: both .ps1 scripts get { mode: 0o600 }, and the .b64 output is
 * pre-created 0o600 by Node BEFORE PowerShell runs ([IO.File]::WriteAllText
 * truncates in place and preserves the existing mode).
 *
 * The temp files are unlinked in `finally`, so this test can't stat them
 * afterwards. Instead we put a fake `powershell.exe` first on PATH: it runs
 * exactly inside the exposure window, stats the temp files while they
 * exist, and logs their modes for the assertions. POSIX-only (sh stub);
 * mode bits are a no-op on real win32 NTFS anyway.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { dpapiStore, dpapiRetrieve } from "../src/keychain.js";

const posixOnly = it.skipIf(process.platform === "win32");

// Fake powershell.exe: finds the -File argument, logs the .ps1 mode; for a
// retrieve script it also logs the mode of the sibling .b64 output (or
// "missing" if Node didn't pre-create it) and then writes $KEY_B64 into it
// so dpapiRetrieve's readFileSync succeeds.
const STUB = `#!/bin/sh
script=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-File" ]; then script="$a"; fi
  prev="$a"
done
if [ -z "$script" ]; then echo ok; exit 0; fi
mode=$(stat -f '%Lp' "$script" 2>/dev/null || stat -c '%a' "$script")
echo "ps1 $mode" >> "$STUB_LOG"
case "$script" in
  *.retrieve.ps1)
    out="\${script%.retrieve.ps1}.b64"
    if [ -e "$out" ]; then
      omode=$(stat -f '%Lp' "$out" 2>/dev/null || stat -c '%a' "$out")
      echo "b64 $omode" >> "$STUB_LOG"
    else
      echo "b64 missing" >> "$STUB_LOG"
    fi
    printf '%s' "$KEY_B64" > "$out"
    ;;
esac
exit 0
`;

describe("keychain DPAPI temp-file permissions (SV-6)", () => {
  let dir: string;
  let logPath: string;
  let savedPath: string | undefined;
  let savedLog: string | undefined;
  let savedKey: string | undefined;
  let savedUmask: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-keychain-perms-"));
    logPath = join(dir, "stub.log");
    const stubPath = join(dir, "powershell.exe");
    writeFileSync(stubPath, STUB);
    chmodSync(stubPath, 0o755);

    savedPath = process.env.PATH;
    savedLog = process.env.STUB_LOG;
    savedKey = process.env.KEY_B64;
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    process.env.STUB_LOG = logPath;
    // Permissive umask so the pre-fix default-mode writes would land 0o644
    // and the assertions below genuinely fail without the fix.
    savedUmask = process.umask(0o022);
  });

  afterEach(() => {
    process.umask(savedUmask);
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.STUB_LOG;
    else process.env.STUB_LOG = savedLog;
    if (savedKey === undefined) delete process.env.KEY_B64;
    else process.env.KEY_B64 = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });

  posixOnly("dpapiStore writes the key-embedding .ps1 with mode 0o600", () => {
    dpapiStore(randomBytes(32), join(dir, "master.dpapi"));
    const log = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(log).toEqual(["ps1 600"]);
  });

  posixOnly("dpapiRetrieve writes the .ps1 AND pre-creates the .b64 output with mode 0o600", () => {
    const key = randomBytes(32);
    process.env.KEY_B64 = key.toString("base64");
    const got = dpapiRetrieve(join(dir, "master.dpapi"));
    expect(got.equals(key)).toBe(true);
    const log = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(log).toEqual(["ps1 600", "b64 600"]);
  });
});
