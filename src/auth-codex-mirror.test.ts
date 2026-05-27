/**
 * Tests for the LAX_MIRROR_CODEX_AUTH gate.
 *
 * Covers env-var parsing, the once-per-process warning, and the
 * gate integration in saveTokens (mirror runs only when env=truthy).
 *
 * Env redirect: saveTokens writes to getAuthPath(), which resolves
 * under HOME/USERPROFILE + ".lax". beforeEach swaps both to an
 * ephemeral tempdir so tests never touch the developer's real auth.json
 * or ~/.codex/.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCodexMirrorEnabled,
  warnMirrorDisabledOnce,
  _resetMirrorOnceFlagForTests,
  mirrorImpl,
} from "./auth-codex-mirror.js";
import { saveTokens, loadTokens } from "./auth.js";
import { _resetMasterKeyCacheForTests } from "./auth-storage.js";
import type { OAuthTokens } from "./types.js";

const ENV_KEYS = ["LAX_MIRROR_CODEX_AUTH", "HOME", "USERPROFILE"] as const;

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

function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "access-test",
    refreshToken: "refresh-test",
    expiresAt: Date.now() + 3_600_000,
    idToken: "header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LXRlc3QifQ.sig",
    ...overrides,
  };
}

let envSnap: Record<string, string | undefined>;
let tempHome: string;

beforeEach(() => {
  envSnap = snapshotEnv();
  delete process.env.LAX_MIRROR_CODEX_AUTH;
  // Redirect getAuthPath() (and ~/.codex/ if anything ever writes there
  // in this file) into a tempdir. Both names matter: getConfigDir reads
  // HOME first, USERPROFILE second; homedir() (used by the mirror's
  // ~/.codex/ path) reads platform-specific vars but USERPROFILE is the
  // Windows source. Setting both keeps the test cross-platform.
  tempHome = mkdtempSync(join(tmpdir(), "lax-auth-test-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  _resetMirrorOnceFlagForTests();
  // Each test starts with a fresh tempdir; the keychain master key
  // cached in auth-storage.ts would otherwise point at the previous
  // test's now-deleted ~/.lax/, leading to wrong-key decrypt errors.
  _resetMasterKeyCacheForTests();
});

afterEach(() => {
  restoreEnv(envSnap);
  vi.restoreAllMocks();
  try {
    if (existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
  } catch { /* tempdir cleanup is best-effort */ }
});

describe("isCodexMirrorEnabled", () => {
  it("returns false when LAX_MIRROR_CODEX_AUTH is unset", () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    expect(isCodexMirrorEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE", "True"])("returns true for truthy value %s", (val) => {
    process.env.LAX_MIRROR_CODEX_AUTH = val;
    expect(isCodexMirrorEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "", "random_garbage"])("returns false for non-truthy value %j", (val) => {
    process.env.LAX_MIRROR_CODEX_AUTH = val;
    expect(isCodexMirrorEnabled()).toBe(false);
  });
});

describe("warnMirrorDisabledOnce", () => {
  it("logs once per process and is silent on subsequent calls", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    warnMirrorDisabledOnce();
    warnMirrorDisabledOnce();
    warnMirrorDisabledOnce();

    const hits = logSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("LAX_MIRROR_CODEX_AUTH"),
    );
    expect(hits.length).toBe(1);
  });

  it("re-arms after _resetMirrorOnceFlagForTests", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    warnMirrorDisabledOnce();
    _resetMirrorOnceFlagForTests();
    warnMirrorDisabledOnce();

    const hits = logSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("LAX_MIRROR_CODEX_AUTH"),
    );
    expect(hits.length).toBe(2);
  });
});

describe("saveTokens gate", () => {
  it("does NOT call the Codex mirror when LAX_MIRROR_CODEX_AUTH is unset, and fires the disabled-once notice", () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    saveTokens(makeTokens());

    expect(mirrorSpy).not.toHaveBeenCalled();
    // LAX-side auth.json was still written (gate only controls the mirror).
    // Disk format is the encrypted-at-rest envelope, not raw JSON.
    const laxAuth = join(tempHome, ".lax", "auth.json");
    expect(existsSync(laxAuth)).toBe(true);
    const onDisk = readFileSync(laxAuth, "utf-8");
    expect(onDisk).toContain('"format":"lax-auth-v1"');
    expect(onDisk).not.toContain("access-test");
    // Roundtrip via the real load path.
    const loaded = loadTokens();
    expect(loaded?.accessToken).toBe("access-test");
    // Disabled-once notice surfaced.
    const noticeHits = logSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("LAX_MIRROR_CODEX_AUTH"),
    );
    expect(noticeHits.length).toBe(1);
  });

  it("DOES call the Codex mirror when LAX_MIRROR_CODEX_AUTH=1", () => {
    process.env.LAX_MIRROR_CODEX_AUTH = "1";
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const tokens = makeTokens();
    saveTokens(tokens);

    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    expect(mirrorSpy).toHaveBeenCalledWith(tokens);
    // Disabled-once notice must NOT fire when the gate is open.
    const noticeHits = logSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Codex CLI credential mirror is disabled"),
    );
    expect(noticeHits.length).toBe(0);
  });
});
