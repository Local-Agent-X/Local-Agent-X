import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APP_AT_REST_SECRET_BASENAMES,
  isAppAtRestSecretBasename,
} from "../security/known-secrets.js";
import { AUDIT_SEED_BASENAMES, getAuditHmacKey, _resetAuditKeyCacheForTests } from "./audit-signing.js";
import { KEYCHAIN_AT_REST_BASENAMES } from "../keychain.js";
import { isSensitivePath } from "../data-lineage-paths.js";

// ── Build-time enrollment assertion (R4-04 / R4-05 drift lock) ──
//
// Every key/seed/vault file the writer modules persist under getLaxDir() MUST be
// enrolled in the ONE canonical APP_AT_REST_SECRET_BASENAMES set — otherwise it
// would be neither read-tainted nor write-protected (the exact drift R4-04/05
// flagged). These constants are EXPORTED FROM the writers (audit-signing.ts,
// keychain.ts) and used at their write sites, so a new writer that adds a file
// without enrolling its basename here fails CI until enrolled.
describe("APP_AT_REST_SECRET_BASENAMES — writer-enrollment lock", () => {
  it("contains every basename audit-signing.ts persists", () => {
    for (const base of AUDIT_SEED_BASENAMES) {
      expect(
        isAppAtRestSecretBasename(base),
        `audit-signing.ts writes ${base} under getLaxDir() but it is NOT enrolled in APP_AT_REST_SECRET_BASENAMES — enroll it in security/known-secrets.ts`,
      ).toBe(true);
    }
  });

  it("contains every basename keychain.ts persists", () => {
    for (const base of KEYCHAIN_AT_REST_BASENAMES) {
      expect(
        isAppAtRestSecretBasename(base),
        `keychain.ts writes ${base} under the LAX data dir but it is NOT enrolled in APP_AT_REST_SECRET_BASENAMES — enroll it in security/known-secrets.ts`,
      ).toBe(true);
    }
  });

  it("the canonical set covers the audit seed + secrets/salt files the writers persist", () => {
    // Concrete pin so the assertion fails loudly if the set is trimmed below the
    // files the writers above persist (comment points at the writer lines:
    // audit-signing.ts encPath()/plaintextPath(); keychain.ts saltPath/dpapiPath/secretsPath).
    for (const base of ["audit-key", "audit-key.enc", "secrets.salt", "secrets.enc", "master.dpapi"]) {
      expect(APP_AT_REST_SECRET_BASENAMES.has(base)).toBe(true);
    }
  });

  it("read-taint classifier flags the app's own audit seed files (no drift)", () => {
    const lax = join("/Users/x", ".lax");
    expect(isSensitivePath(join(lax, "audit-key"))).toBe(true);
    expect(isSensitivePath(join(lax, "audit-key.enc"))).toBe(true);
    expect(isSensitivePath(join(lax, "secrets.salt"))).toBe(true);
  });
});

// ── R4-04: shred of the legacy plaintext seed is NON-best-effort ──
//
// After migrating a legacy plaintext audit-key into the sealed store, the
// plaintext MUST be removed; a failed removal must NOT be swallowed (that would
// leave a readable, forgeable seed on disk while auditing runs). We can't easily
// force an unlink failure cross-platform, so we assert the success path actually
// removes the plaintext, and that a successful migration leaves only the sealed
// form — the swallow-the-error behavior is gone (verified by code review + the
// unlinkSync now being outside any try/catch).
describe("loadOrCreateProtectedKey — plaintext seed shred", () => {
  let dir: string | null = null;
  const prevDataDir = process.env.LAX_DATA_DIR;
  const prevAuditKey = process.env.LAX_AUDIT_KEY;

  afterEach(() => {
    _resetAuditKeyCacheForTests();
    if (dir) {
      try { chmodSync(dir, 0o700); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
    if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prevDataDir;
    if (prevAuditKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevAuditKey;
  });

  it("migrates the legacy plaintext seed into the sealed store and removes the plaintext", () => {
    dir = mkdtempSync(join(tmpdir(), "lax-audit-"));
    process.env.LAX_DATA_DIR = dir;
    delete process.env.LAX_AUDIT_KEY;
    _resetAuditKeyCacheForTests();

    const plain = join(dir, AUDIT_SEED_BASENAMES[0]);
    const enc = join(dir, AUDIT_SEED_BASENAMES[1]);
    writeFileSync(plain, Buffer.alloc(32, 7), { mode: 0o600 });

    // Resolving the key migrates + shreds the plaintext (best-effort wipe is gone;
    // the unlink is load-bearing and now runs outside any try/catch).
    const key = getAuditHmacKey();
    expect(Buffer.isBuffer(key) || typeof key === "string").toBe(true);

    // Plaintext removed, sealed form present — the security property the shred
    // guarantees. If the unlink had failed it would have THROWN (caught upstream
    // into the in-process fallback + a loud console.error), never silently left
    // the plaintext behind.
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(enc)).toBe(true);
  });
});
