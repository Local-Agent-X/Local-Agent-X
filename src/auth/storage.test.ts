/**
 * Tests for auth-storage: AES-GCM envelope wrapping for auth.json, plus
 * integration tests that drive the real saveTokens / loadTokens through
 * the wrapper to verify on-disk format and plaintext-migration.
 *
 * The integration tests redirect HOME / USERPROFILE to mkdtempSync so they
 * never touch the developer's real ~/.lax/auth.json. Same pattern as
 * auth-codex-mirror.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  encryptAuthBlob,
  decryptAuthBlob,
  encryptWithKey,
  decryptWithKey,
  _resetMasterKeyCacheForTests,
  _setMasterKeyCacheForTests,
  _encryptV1WithKeyForTests,
  _encryptBasenameBoundV2ForTests,
  _credentialAadForTests,
  ENVELOPE_FORMAT,
  LEGACY_ENVELOPE_FORMAT,
  PROBE_CREDENTIAL_PATH_ENV,
  readProviderCredentials,
  writeProviderCredentials,
} from "./storage.js";
import { saveTokens, loadTokens } from "./index.js";
import { loadAnthropicTokens, saveAnthropicSetupToken } from "./anthropic.js";
import { loadXaiTokens, saveXaiTokens } from "./xai.js";
import type { OAuthTokens } from "../types.js";

const ENV_KEYS = [
  "LAX_MIRROR_CODEX_AUTH", "LAX_DATA_DIR", "LAX_SELF_EDIT_PROBE",
  PROBE_CREDENTIAL_PATH_ENV, "HOME", "USERPROFILE",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

let envSnap: Record<string, string | undefined>;
let tempHome: string;
let dataDir: string;

beforeEach(() => {
  envSnap = snapshotEnv();
  // Gate mirror off so tests don't try to install @openai/codex or write ~/.codex/.
  delete process.env.LAX_MIRROR_CODEX_AUTH;
  tempHome = mkdtempSync(join(tmpdir(), "lax-auth-storage-test-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  dataDir = join(tempHome, ".lax");
  process.env.LAX_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  _resetMasterKeyCacheForTests();
});

afterEach(() => {
  restoreEnv(envSnap);
  _resetMasterKeyCacheForTests();
  try {
    if (existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
  } catch { /* tempdir cleanup is best-effort */ }
});

describe("encryptWithKey / decryptWithKey (pure)", () => {
  it("roundtrips a simple string", () => {
    const key = randomBytes(32);
    const env = encryptWithKey("hello world", key);
    expect(decryptWithKey(env, key)).toBe("hello world");
  });

  it("rejects encryption keys that aren't 32 bytes", () => {
    expect(() => encryptWithKey("x", randomBytes(16))).toThrow(/32 bytes/);
  });

  it("rejects decryption keys that aren't 32 bytes", () => {
    const key = randomBytes(32);
    const env = encryptWithKey("x", key);
    expect(() => decryptWithKey(env, randomBytes(24))).toThrow(/32 bytes/);
  });

  it("envelope JSON contains the format marker and base64 fields", () => {
    const key = randomBytes(32);
    const env = JSON.parse(encryptWithKey("payload", key));
    expect(env.format).toBe(ENVELOPE_FORMAT);
    expect(typeof env.iv).toBe("string");
    expect(typeof env.ciphertext).toBe("string");
    expect(typeof env.tag).toBe("string");
    expect(Buffer.from(env.iv, "base64").length).toBe(12);
    expect(Buffer.from(env.tag, "base64").length).toBe(16);
  });

  it("tamper-resistance: flipping a byte in ciphertext throws on decrypt", () => {
    const key = randomBytes(32);
    const env = JSON.parse(encryptWithKey("important payload", key));
    const ctBuf = Buffer.from(env.ciphertext, "base64");
    ctBuf[0] = ctBuf[0] ^ 0xff;
    env.ciphertext = ctBuf.toString("base64");
    expect(() => decryptWithKey(JSON.stringify(env), key)).toThrow();
  });

  it("tamper-resistance: flipping a byte in the auth tag throws on decrypt", () => {
    const key = randomBytes(32);
    const env = JSON.parse(encryptWithKey("important payload", key));
    const tagBuf = Buffer.from(env.tag, "base64");
    tagBuf[0] = tagBuf[0] ^ 0xff;
    env.tag = tagBuf.toString("base64");
    expect(() => decryptWithKey(JSON.stringify(env), key)).toThrow();
  });

  it("wrong key: encrypt with key A, decrypt with key B throws", () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const env = encryptWithKey("secret", keyA);
    expect(() => decryptWithKey(env, keyB)).toThrow();
  });

  it("unicode safety: emoji + non-ASCII roundtrips exactly", () => {
    const key = randomBytes(32);
    const plaintext = "🔐 secret with emoji — café, naïve, 日本語, Ω";
    const env = encryptWithKey(plaintext, key);
    expect(decryptWithKey(env, key)).toBe(plaintext);
  });

  it("large payload: 10KB string roundtrips exactly", () => {
    const key = randomBytes(32);
    // 10KB of mixed content, structured like a fat JSON blob.
    const big = JSON.stringify({
      accessToken: "x".repeat(4096),
      refreshToken: "y".repeat(4096),
      idToken: "z".repeat(2048),
      expiresAt: Date.now(),
    });
    expect(big.length).toBeGreaterThan(10_000);
    const env = encryptWithKey(big, key);
    expect(decryptWithKey(env, key)).toBe(big);
  });

  it("rejects malformed envelope JSON", () => {
    const key = randomBytes(32);
    expect(() => decryptWithKey("not json", key)).toThrow(/not valid JSON/);
  });

  it("rejects envelope missing required fields", () => {
    const key = randomBytes(32);
    expect(() => decryptWithKey(JSON.stringify({ format: "lax-auth-v1" }), key)).toThrow(/missing required fields/);
  });

  it("rejects envelope with wrong IV length", () => {
    const key = randomBytes(32);
    const bogus = JSON.stringify({
      format: ENVELOPE_FORMAT,
      iv: Buffer.alloc(8).toString("base64"),
      ciphertext: "AAAA",
      tag: Buffer.alloc(16).toString("base64"),
    });
    expect(() => decryptWithKey(bogus, key)).toThrow(/iv must be 12 bytes/);
  });

  it("normalizes equivalent Windows paths to the same full-path AAD", () => {
    const backslashes = _credentialAadForTests("core", "C:\\Users\\Example\\..\\Data\\auth.json");
    const slashes = _credentialAadForTests("core", "c:/users/data/auth.json");
    expect(backslashes).toBe(slashes);
    expect(backslashes).toContain("c:/users/data/auth.json");
  });
});

describe("encryptAuthBlob / decryptAuthBlob (keychain-backed)", () => {
  it("roundtrips a string through the keychain master key", () => {
    const env = encryptAuthBlob("hello world", dataDir);
    expect(decryptAuthBlob(env, dataDir)).toEqual({
      plaintext: "hello world",
      wasEncrypted: true,
      format: "v2",
    });
  });

  it("detects legacy plaintext OAuth file shape and returns it verbatim", () => {
    const legacy = JSON.stringify({
      accessToken: "x",
      refreshToken: "y",
      expiresAt: 123,
    });
    expect(decryptAuthBlob(legacy, dataDir)).toEqual({
      plaintext: legacy,
      wasEncrypted: false,
      format: "plaintext",
    });
  });

  it("throws on a valid-shape envelope with garbage ciphertext", () => {
    const garbage = JSON.stringify({
      format: ENVELOPE_FORMAT,
      iv: Buffer.alloc(12).toString("base64"),
      ciphertext: Buffer.from("garbage data here").toString("base64"),
      tag: Buffer.alloc(16).toString("base64"),
    });
    expect(() => decryptAuthBlob(garbage, dataDir)).toThrow();
  });

  it("throws on neither-plaintext-nor-envelope shapes", () => {
    expect(() => decryptAuthBlob(JSON.stringify({ foo: "bar" }), dataDir)).toThrow(/neither legacy plaintext nor a recognized envelope/);
  });

  it("throws on malformed input JSON", () => {
    expect(() => decryptAuthBlob("not json at all", dataDir)).toThrow(/not valid JSON/);
  });
});

describe("provider credential writes", () => {
  it("fails closed when encryption cannot produce an envelope", () => {
    const authPath = join(dataDir, "fail-closed.json");
    _setMasterKeyCacheForTests(randomBytes(16));

    expect(() => writeProviderCredentials(authPath, "core", {
      accessToken: "secret",
      refreshToken: "refresh",
      expiresAt: 1,
    }))
      .toThrow(/refusing unencrypted credential write/);
    expect(existsSync(authPath)).toBe(false);
  });

  it("writes plaintext only in explicit degraded mode and warns", () => {
    const authPath = join(dataDir, "degraded.json");
    const warnings: string[] = [];
    _setMasterKeyCacheForTests(randomBytes(16));

    writeProviderCredentials(
      authPath,
      "core",
      { accessToken: "degraded-secret", refreshToken: "refresh", expiresAt: 1 },
      { allowUnencryptedWrite: true, warn: (message) => warnings.push(message) },
    );

    expect(readFileSync(authPath, "utf-8")).toContain("degraded-secret");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/degraded mode was explicitly enabled/);
  });

  it("rejects provider fields outside the strict namespace schema", () => {
    const authPath = join(dataDir, "xai-auth.json");
    expect(() => writeProviderCredentials(authPath, "xai", {
      accessToken: "secret",
      provider: "anthropic",
      unexpected: true,
    })).toThrow(/unexpected credential fields|provider marker/);
    expect(existsSync(authPath)).toBe(false);
  });
});

describe("shared provider stores", () => {
  it("encrypts and loads Anthropic setup tokens", () => {
    const token = "anthropic-setup-token-secret";
    saveAnthropicSetupToken(token);

    const authPath = join(dataDir, "anthropic-auth.json");
    const onDisk = readFileSync(authPath, "utf-8");
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(onDisk).not.toContain(token);
    expect(loadAnthropicTokens()?.accessToken).toBe(token);
  });

  it("migrates legacy plaintext Anthropic setup tokens on first load", () => {
    const authPath = join(dataDir, "anthropic-auth.json");
    writeFileSync(authPath, JSON.stringify({
      accessToken: "legacy-anthropic-token",
      method: "token",
      provider: "anthropic",
    }));

    expect(loadAnthropicTokens()?.accessToken).toBe("legacy-anthropic-token");
    const onDisk = readFileSync(authPath, "utf-8");
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(onDisk).not.toContain("legacy-anthropic-token");
  });

  it("encrypts and loads xAI tokens", () => {
    const tokens = {
      accessToken: "xai-access-secret",
      refreshToken: "xai-refresh-secret",
      expiresAt: Date.now() + 60_000,
      provider: "xai" as const,
    };
    saveXaiTokens(tokens);

    const authPath = join(dataDir, "xai-auth.json");
    const onDisk = readFileSync(authPath, "utf-8");
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(onDisk).not.toContain(tokens.accessToken);
    expect(loadXaiTokens()).toEqual(tokens);
  });

  it("migrates legacy plaintext xAI tokens on first load", () => {
    const authPath = join(dataDir, "xai-auth.json");
    writeFileSync(authPath, JSON.stringify({
      accessToken: "legacy-xai-token",
      provider: "xai",
    }));

    expect(loadXaiTokens()?.accessToken).toBe("legacy-xai-token");
    const onDisk = readFileSync(authPath, "utf-8");
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(onDisk).not.toContain("legacy-xai-token");
  });

  it("rejects a v2 envelope swapped into another provider file", () => {
    saveTokens({ accessToken: "core-access", refreshToken: "core-refresh", expiresAt: 123 });
    const corePath = join(dataDir, "auth.json");
    const xaiPath = join(dataDir, "xai-auth.json");
    const swapped = readFileSync(corePath, "utf-8");
    writeFileSync(xaiPath, swapped);

    expect(() => decryptAuthBlob(swapped, dataDir, "xai", xaiPath)).toThrow();
    expect(loadXaiTokens()).toBeNull();
  });

  it("migrates basename-bound v2 before rejecting a same-name cross-directory swap", () => {
    const key = randomBytes(32);
    const sourceDir = join(dataDir, "source");
    const destinationDir = join(dataDir, "destination");
    const sourcePath = join(sourceDir, "auth.json");
    const destinationPath = join(destinationDir, "auth.json");
    const tokens = { accessToken: "bound-access", refreshToken: "bound-refresh", expiresAt: 123 };
    mkdirSync(sourceDir);
    mkdirSync(destinationDir);
    _setMasterKeyCacheForTests(key);
    const basenameBound = _encryptBasenameBoundV2ForTests(
      JSON.stringify(tokens), key, "core", sourcePath,
    );
    writeFileSync(sourcePath, basenameBound);

    expect(readProviderCredentials(sourcePath, "core")).toEqual(tokens);
    const migrated = readFileSync(sourcePath, "utf-8");
    expect(migrated).not.toBe(basenameBound);

    writeFileSync(destinationPath, migrated);
    expect(() => readProviderCredentials(destinationPath, "core")).toThrow();
  });

  it("reads the canonical parent envelope in a fresh probe data dir", () => {
    const tokens = { accessToken: "probe-xai", provider: "xai" as const };
    saveXaiTokens(tokens);
    const canonicalPath = join(dataDir, "xai-auth.json");
    const probeDir = join(tempHome, "probe-data");
    mkdirSync(probeDir);
    process.env.LAX_SELF_EDIT_PROBE = "1";
    process.env[PROBE_CREDENTIAL_PATH_ENV] = canonicalPath;
    process.env.LAX_DATA_DIR = probeDir;

    expect(loadXaiTokens()).toEqual(tokens);
    expect(existsSync(join(probeDir, "xai-auth.json"))).toBe(false);
  });
});

describe("auth.ts integration: saveTokens / loadTokens round-trip", () => {
  function freshTokens(): OAuthTokens {
    return {
      accessToken: "access-secret-abc123",
      refreshToken: "refresh-secret-xyz789",
      expiresAt: Date.now() + 60_000,
    };
  }

  it("save → load roundtrip writes an envelope and reads back the same tokens", () => {
    const tokens = freshTokens();
    saveTokens(tokens);

    const authPath = join(dataDir, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    const onDisk = readFileSync(authPath, "utf-8");
    // Envelope marker present.
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    // Sensitive material NOT visible on disk.
    expect(onDisk).not.toContain("access-secret-abc123");
    expect(onDisk).not.toContain("refresh-secret-xyz789");

    const loaded = loadTokens();
    expect(loaded).not.toBeNull();
    expect(loaded?.accessToken).toBe(tokens.accessToken);
    expect(loaded?.refreshToken).toBe(tokens.refreshToken);
    expect(loaded?.expiresAt).toBe(tokens.expiresAt);
  });

  it("migrates a legacy plaintext auth.json on first load", () => {
    const authPath = join(dataDir, "auth.json");
    const legacy: OAuthTokens = {
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      expiresAt: Date.now() + 60_000,
    };
    writeFileSync(authPath, JSON.stringify(legacy, null, 2), { mode: 0o600 });

    // Sanity: starts as plaintext.
    const before = readFileSync(authPath, "utf-8");
    expect(before).toContain("legacy-access-token");
    expect(before).not.toContain(ENVELOPE_FORMAT);

    const loaded = loadTokens();
    expect(loaded?.accessToken).toBe("legacy-access-token");
    expect(loaded?.refreshToken).toBe("legacy-refresh-token");

    // After load, file is now an envelope and the plaintext token value
    // is no longer recoverable from a disk-only read.
    const after = readFileSync(authPath, "utf-8");
    expect(after).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(after).not.toContain("legacy-access-token");
    expect(after).not.toContain("legacy-refresh-token");

    // And the next loadTokens reads it back correctly.
    const reloaded = loadTokens();
    expect(reloaded?.accessToken).toBe("legacy-access-token");
    expect(reloaded?.refreshToken).toBe("legacy-refresh-token");
  });

  it("migrates a v1 encrypted envelope to provider-bound v2", () => {
    const authPath = join(dataDir, "auth.json");
    const key = randomBytes(32);
    const tokens = freshTokens();
    _setMasterKeyCacheForTests(key);
    writeFileSync(authPath, _encryptV1WithKeyForTests(JSON.stringify(tokens), key));
    expect(readFileSync(authPath, "utf-8")).toContain(LEGACY_ENVELOPE_FORMAT);

    expect(loadTokens()).toEqual(tokens);
    const migrated = readFileSync(authPath, "utf-8");
    expect(migrated).toContain(ENVELOPE_FORMAT);
    expect(migrated).not.toContain(LEGACY_ENVELOPE_FORMAT);
  });

  it("does not return legacy plaintext when encrypted migration fails", () => {
    const authPath = join(dataDir, "auth.json");
    const legacy = freshTokens();
    writeFileSync(authPath, JSON.stringify(legacy), { mode: 0o600 });
    _setMasterKeyCacheForTests(randomBytes(16));

    expect(loadTokens()).toBeNull();
    expect(readFileSync(authPath, "utf-8")).toContain(legacy.accessToken);
  });

  it("loadTokens returns null when the envelope is tampered (caller sees as no-auth)", () => {
    saveTokens(freshTokens());
    const authPath = join(dataDir, "auth.json");
    const env = JSON.parse(readFileSync(authPath, "utf-8"));
    const ctBuf = Buffer.from(env.ciphertext, "base64");
    ctBuf[0] = ctBuf[0] ^ 0xff;
    env.ciphertext = ctBuf.toString("base64");
    writeFileSync(authPath, JSON.stringify(env), { mode: 0o600 });

    expect(loadTokens()).toBeNull();
  });

  it("loadTokens returns null on garbage file (caller sees as no-auth)", () => {
    const authPath = join(dataDir, "auth.json");
    writeFileSync(authPath, "not json at all", { mode: 0o600 });
    expect(loadTokens()).toBeNull();
  });
});
