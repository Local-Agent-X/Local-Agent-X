/**
 * At-rest encryption for ~/.lax/anthropic-auth.json. Locks that the token
 * store is written as a lax-auth-v1 envelope (not raw tokens), and that a
 * legacy plaintext file — including the method:"token" shape with NO
 * refreshToken, which storage.ts's own plaintext detection can't recognize —
 * loads correctly and is migrated to an envelope on first load.
 *
 * Uses LAX_DATA_DIR to redirect the data dir to a mkdtempSync so the
 * developer's real ~/.lax/anthropic-auth.json is never touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAnthropicTokens, saveAnthropicTokens, type AnthropicTokens } from "./anthropic.js";
import { _resetMasterKeyCacheForTests, ENVELOPE_FORMAT } from "./storage.js";

// Injectable keychain failure: when set, getOrCreateMasterKey throws with this
// message — simulates a genuinely unavailable/corrupt key path, which the test
// env's LAX_DISABLE_OS_KEYCHAIN file-fallback can never produce on its own.
let mockKeychainFailure: string | null = null;
vi.mock("../keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../keychain.js")>();
  return {
    ...actual,
    getOrCreateMasterKey: (dataDir: string) => {
      if (mockKeychainFailure) throw new Error(mockKeychainFailure);
      return actual.getOrCreateMasterKey(dataDir);
    },
  };
});

const ENV_KEYS = ["LAX_DATA_DIR", "LAX_DISABLE_OS_KEYCHAIN", "LAX_ALLOW_PLAINTEXT_AUTH"] as const;

let envSnap: Record<string, string | undefined>;
let dataDir: string;

beforeEach(() => {
  envSnap = {};
  for (const k of ENV_KEYS) envSnap[k] = process.env[k];
  dataDir = mkdtempSync(join(tmpdir(), "lax-anthropic-auth-test-"));
  process.env.LAX_DATA_DIR = dataDir;
  process.env.LAX_DISABLE_OS_KEYCHAIN = "1";
  delete process.env.LAX_ALLOW_PLAINTEXT_AUTH;
  mockKeychainFailure = null;
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

describe("anthropic token store encryption at rest", () => {
  it("save → load roundtrip writes an envelope, not raw tokens", () => {
    const tokens: AnthropicTokens = {
      accessToken: "anthropic-access-secret-123",
      refreshToken: "anthropic-refresh-secret-456",
      expiresAt: Date.now() + 60_000,
      method: "oauth",
      provider: "anthropic",
    };
    saveAnthropicTokens(tokens);

    const authPath = join(dataDir, "anthropic-auth.json");
    expect(existsSync(authPath)).toBe(true);
    const onDisk = readFileSync(authPath, "utf-8");
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(onDisk).not.toContain("anthropic-access-secret-123");
    expect(onDisk).not.toContain("anthropic-refresh-secret-456");

    const loaded = loadAnthropicTokens();
    expect(loaded?.accessToken).toBe(tokens.accessToken);
    expect(loaded?.refreshToken).toBe(tokens.refreshToken);
    expect(loaded?.expiresAt).toBe(tokens.expiresAt);
    expect(loaded?.method).toBe("oauth");
  });

  it("migrates a legacy plaintext oauth-shaped file on first load", () => {
    const authPath = join(dataDir, "anthropic-auth.json");
    writeFileSync(authPath, JSON.stringify({
      accessToken: "legacy-anthropic-access",
      refreshToken: "legacy-anthropic-refresh",
      expiresAt: Date.now() + 60_000,
    }, null, 2), { mode: 0o600 });

    const loaded = loadAnthropicTokens();
    expect(loaded?.accessToken).toBe("legacy-anthropic-access");
    expect(loaded?.method).toBe("oauth");

    const after = readFileSync(authPath, "utf-8");
    expect(after).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(after).not.toContain("legacy-anthropic-access");
    expect(after).not.toContain("legacy-anthropic-refresh");

    // Next load reads the envelope back correctly.
    const reloaded = loadAnthropicTokens();
    expect(reloaded?.accessToken).toBe("legacy-anthropic-access");
  });

  it("migrates a legacy method:token file (no refreshToken) on first load", () => {
    // This shape defeats storage.ts's own plaintext detection (which keys on
    // refreshToken) — the loader must still recognize and migrate it.
    const authPath = join(dataDir, "anthropic-auth.json");
    writeFileSync(authPath, JSON.stringify({
      accessToken: "legacy-setup-token-789",
      method: "token",
    }, null, 2), { mode: 0o600 });

    const loaded = loadAnthropicTokens();
    expect(loaded?.accessToken).toBe("legacy-setup-token-789");
    expect(loaded?.method).toBe("token");

    const after = readFileSync(authPath, "utf-8");
    expect(after).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(after).not.toContain("legacy-setup-token-789");

    const reloaded = loadAnthropicTokens();
    expect(reloaded?.accessToken).toBe("legacy-setup-token-789");
    expect(reloaded?.method).toBe("token");
  });

  it("returns null (no-auth) on a tampered envelope", () => {
    saveAnthropicTokens({ accessToken: "a", method: "token", provider: "anthropic" });
    const authPath = join(dataDir, "anthropic-auth.json");
    const env = JSON.parse(readFileSync(authPath, "utf-8"));
    const ctBuf = Buffer.from(env.ciphertext, "base64");
    ctBuf[0] = ctBuf[0] ^ 0xff;
    env.ciphertext = ctBuf.toString("base64");
    writeFileSync(authPath, JSON.stringify(env), { mode: 0o600 });

    expect(loadAnthropicTokens()).toBeNull();
  });
});

describe("anthropic token store: no silent plaintext on encryption failure", () => {
  const tokens: AnthropicTokens = {
    accessToken: "anthropic-secret-token-abc",
    method: "token",
    provider: "anthropic",
  };

  it("encryption failure → save throws and writes NO file", () => {
    mockKeychainFailure = "keychain unavailable — simulated";
    _resetMasterKeyCacheForTests();
    const authPath = join(dataDir, "anthropic-auth.json");
    expect(() => saveAnthropicTokens(tokens)).toThrow(/token encryption failed/);
    expect(existsSync(authPath)).toBe(false);
  });

  it("LAX_ALLOW_PLAINTEXT_AUTH=1: writes plaintext in explicit degraded mode", () => {
    mockKeychainFailure = "keychain unavailable — simulated";
    _resetMasterKeyCacheForTests();
    process.env.LAX_ALLOW_PLAINTEXT_AUTH = "1";
    saveAnthropicTokens(tokens);
    const onDisk = readFileSync(join(dataDir, "anthropic-auth.json"), "utf-8");
    expect(onDisk).toContain("anthropic-secret-token-abc");
    expect(onDisk).not.toContain(ENVELOPE_FORMAT);
    expect(loadAnthropicTokens()?.accessToken).toBe(tokens.accessToken);
  });
});
