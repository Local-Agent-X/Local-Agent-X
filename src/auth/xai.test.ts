// Refresh-timing policy for xAI OAuth tokens. Locks the intent that we proactively
// refresh ~1h before the real expiry (not the old ~minutes-before window), and that
// the skew is applied ONCE — expiresAt holds the REAL expiry, so isXaiTokenExpired
// and shouldRefreshXaiToken don't double-count it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRefreshXaiToken, isXaiTokenExpired, loadXaiTokens, saveXaiTokens, type XaiTokens } from "./xai.js";
import { _resetMasterKeyCacheForTests, ENVELOPE_FORMAT } from "./storage.js";

function tok(expiresInMs: number | undefined): XaiTokens {
  return {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: expiresInMs === undefined ? undefined : Date.now() + expiresInMs,
    provider: "xai",
  };
}

describe("xAI token refresh timing", () => {
  it("refreshes ~1h before expiry, not just minutes before (regression guard)", () => {
    // 30 min of life left is inside the 1h window → due for refresh. Under the old
    // ~2-4 min window this was FALSE; that gap is what stranded long-idle callers.
    expect(shouldRefreshXaiToken(tok(30 * 60 * 1000))).toBe(true);
  });

  it("leaves a token with plenty of life alone", () => {
    expect(shouldRefreshXaiToken(tok(2 * 60 * 60 * 1000))).toBe(false);
  });

  it("refreshes an already-expired token", () => {
    expect(shouldRefreshXaiToken(tok(-60 * 1000))).toBe(true);
  });

  it("does not force a refresh when expiry is unknown or there is no token", () => {
    expect(shouldRefreshXaiToken(tok(undefined))).toBe(false);
    expect(shouldRefreshXaiToken(null)).toBe(false);
  });

  it("isXaiTokenExpired reflects REAL expiry, so the skew is applied only once", () => {
    // Inside the refresh window but not actually expired → refresh due, NOT expired.
    // If the skew were still double-counted, expiresAt would already be shifted and
    // this invariant would drift.
    expect(shouldRefreshXaiToken(tok(30 * 60 * 1000))).toBe(true);
    expect(isXaiTokenExpired(tok(30 * 60 * 1000))).toBe(false);
    expect(isXaiTokenExpired(tok(-1000))).toBe(true);
  });
});

// At-rest encryption for ~/.lax/xai-auth.json. Locks that the token store is
// written as a lax-auth-v1 envelope (not raw tokens), and that a legacy
// plaintext file loads correctly and is migrated to an envelope on first
// load. LAX_DATA_DIR redirects the data dir to a mkdtempSync so the
// developer's real ~/.lax/xai-auth.json is never touched.
describe("xAI token store encryption at rest", () => {
  const ENV_KEYS = ["LAX_DATA_DIR", "LAX_DISABLE_OS_KEYCHAIN"] as const;
  let envSnap: Record<string, string | undefined>;
  let dataDir: string;

  beforeEach(() => {
    envSnap = {};
    for (const k of ENV_KEYS) envSnap[k] = process.env[k];
    dataDir = mkdtempSync(join(tmpdir(), "lax-xai-auth-test-"));
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_DISABLE_OS_KEYCHAIN = "1";
    _resetMasterKeyCacheForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (envSnap[k] === undefined) delete process.env[k];
      else process.env[k] = envSnap[k];
    }
    _resetMasterKeyCacheForTests();
    try {
      if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    } catch { /* tempdir cleanup is best-effort */ }
  });

  it("save → load roundtrip writes an envelope, not raw tokens", () => {
    const tokens: XaiTokens = {
      accessToken: "xai-access-secret-123",
      refreshToken: "xai-refresh-secret-456",
      expiresAt: Date.now() + 60_000,
      provider: "xai",
    };
    saveXaiTokens(tokens);

    const authPath = join(dataDir, "xai-auth.json");
    expect(existsSync(authPath)).toBe(true);
    const onDisk = readFileSync(authPath, "utf-8");
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(onDisk).not.toContain("xai-access-secret-123");
    expect(onDisk).not.toContain("xai-refresh-secret-456");

    const loaded = loadXaiTokens();
    expect(loaded?.accessToken).toBe(tokens.accessToken);
    expect(loaded?.refreshToken).toBe(tokens.refreshToken);
    expect(loaded?.expiresAt).toBe(tokens.expiresAt);
  });

  it("migrates a legacy plaintext file on first load", () => {
    const authPath = join(dataDir, "xai-auth.json");
    writeFileSync(authPath, JSON.stringify({
      accessToken: "legacy-xai-access",
      refreshToken: "legacy-xai-refresh",
      expiresAt: Date.now() + 60_000,
    }, null, 2), { mode: 0o600 });

    const loaded = loadXaiTokens();
    expect(loaded?.accessToken).toBe("legacy-xai-access");
    expect(loaded?.refreshToken).toBe("legacy-xai-refresh");

    const after = readFileSync(authPath, "utf-8");
    expect(after).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(after).not.toContain("legacy-xai-access");
    expect(after).not.toContain("legacy-xai-refresh");

    const reloaded = loadXaiTokens();
    expect(reloaded?.accessToken).toBe("legacy-xai-access");
  });

  it("migrates a legacy plaintext file with NO refreshToken on first load", () => {
    // storage.ts's own plaintext detection keys on refreshToken; the loader
    // must still recognize and migrate a token-only file.
    const authPath = join(dataDir, "xai-auth.json");
    writeFileSync(authPath, JSON.stringify({ accessToken: "legacy-xai-bare" }, null, 2), { mode: 0o600 });

    const loaded = loadXaiTokens();
    expect(loaded?.accessToken).toBe("legacy-xai-bare");

    const after = readFileSync(authPath, "utf-8");
    expect(after).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(after).not.toContain("legacy-xai-bare");
  });

  it("returns null (no-auth) on a tampered envelope", () => {
    saveXaiTokens({ accessToken: "a", provider: "xai" });
    const authPath = join(dataDir, "xai-auth.json");
    const env = JSON.parse(readFileSync(authPath, "utf-8"));
    const ctBuf = Buffer.from(env.ciphertext, "base64");
    ctBuf[0] = ctBuf[0] ^ 0xff;
    env.ciphertext = ctBuf.toString("base64");
    writeFileSync(authPath, JSON.stringify(env), { mode: 0o600 });

    expect(loadXaiTokens()).toBeNull();
  });
});
