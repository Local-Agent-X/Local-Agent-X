/**
 * Tests for the Codex CLI credential bridge gating (R6-A2).
 *
 * The mirror no longer writes ~/.codex/auth.json on every login/refresh by
 * default. Instead:
 *   - LAX_MIRROR_CODEX_AUTH=1 → eager persistent mirror (saveTokens writes it)
 *   - LAX_MIRROR_CODEX_AUTH=0 → never mirror, not even for a build
 *   - default                → build_app writes it just-in-time via
 *                              prepareCodexAuthForBuild and removes it after
 *
 * Env redirect: saveTokens writes to getAuthPath() (HOME/USERPROFILE + ".lax")
 * and the mirror writes ~/.codex/. beforeEach swaps HOME + USERPROFILE to an
 * ephemeral tempdir so tests never touch the developer's real files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCodexEagerMirrorEnabled,
  isCodexMirrorDisabled,
  isCodexAutoInstallEnabled,
  prepareCodexAuthForBuild,
  mirrorImpl,
} from "./codex-mirror.js";
import { saveTokens, loadTokens } from "./index.js";
import { _resetMasterKeyCacheForTests, ENVELOPE_FORMAT } from "./storage.js";
import type { OAuthTokens } from "../types.js";

const ENV_KEYS = ["LAX_MIRROR_CODEX_AUTH", "LAX_INSTALL_CODEX_CLI", "HOME", "USERPROFILE"] as const;

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
let codexPath: string;

beforeEach(() => {
  envSnap = snapshotEnv();
  delete process.env.LAX_MIRROR_CODEX_AUTH;
  delete process.env.LAX_INSTALL_CODEX_CLI;
  tempHome = mkdtempSync(join(tmpdir(), "lax-auth-test-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  codexPath = join(tempHome, ".codex", "auth.json");
  _resetMasterKeyCacheForTests();
});

afterEach(() => {
  restoreEnv(envSnap);
  vi.restoreAllMocks();
  try {
    if (existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
  } catch { /* tempdir cleanup is best-effort */ }
});

describe("isCodexEagerMirrorEnabled", () => {
  it("is false by default (no eager mirror on every saveTokens)", () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    expect(isCodexEagerMirrorEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE"])("is true for opt-in value %s", (val) => {
    process.env.LAX_MIRROR_CODEX_AUTH = val;
    expect(isCodexEagerMirrorEnabled()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "", "garbage"])("is false for non-opt-in value %j", (val) => {
    process.env.LAX_MIRROR_CODEX_AUTH = val;
    expect(isCodexEagerMirrorEnabled()).toBe(false);
  });
});

describe("isCodexMirrorDisabled", () => {
  it("is false by default", () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    expect(isCodexMirrorDisabled()).toBe(false);
  });

  it.each(["0", "false", "FALSE", "off", "no"])("is true for hard opt-out value %s", (val) => {
    process.env.LAX_MIRROR_CODEX_AUTH = val;
    expect(isCodexMirrorDisabled()).toBe(true);
  });

  it("is false when eager-enabled (=1)", () => {
    process.env.LAX_MIRROR_CODEX_AUTH = "1";
    expect(isCodexMirrorDisabled()).toBe(false);
  });
});

describe("isCodexAutoInstallEnabled", () => {
  it("returns false when LAX_INSTALL_CODEX_CLI is unset", () => {
    delete process.env.LAX_INSTALL_CODEX_CLI;
    expect(isCodexAutoInstallEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE", "True"])("returns true for truthy value %s", (val) => {
    process.env.LAX_INSTALL_CODEX_CLI = val;
    expect(isCodexAutoInstallEnabled()).toBe(true);
  });

  it("is independent of LAX_MIRROR_CODEX_AUTH — install gate is its own consent decision", () => {
    process.env.LAX_MIRROR_CODEX_AUTH = "1";
    delete process.env.LAX_INSTALL_CODEX_CLI;
    expect(isCodexEagerMirrorEnabled()).toBe(true);
    expect(isCodexAutoInstallEnabled()).toBe(false);
  });
});

describe("saveTokens eager-mirror gate", () => {
  it("does NOT mirror by default (the plaintext copy stays off disk until a build)", () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {});

    saveTokens(makeTokens());

    expect(mirrorSpy).not.toHaveBeenCalled();
    // LAX-side auth.json is still written, encrypted-at-rest.
    const laxAuth = join(tempHome, ".lax", "auth.json");
    expect(existsSync(laxAuth)).toBe(true);
    const onDisk = readFileSync(laxAuth, "utf-8");
    expect(onDisk).toContain(`"format":"${ENVELOPE_FORMAT}"`);
    expect(onDisk).not.toContain("access-test");
    expect(loadTokens()?.accessToken).toBe("access-test");
  });

  it("DOES mirror eagerly when LAX_MIRROR_CODEX_AUTH=1", () => {
    process.env.LAX_MIRROR_CODEX_AUTH = "1";
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {});

    const tokens = makeTokens();
    saveTokens(tokens);

    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    expect(mirrorSpy).toHaveBeenCalledWith(tokens);
  });
});

describe("prepareCodexAuthForBuild", () => {
  it("default: writes the mirror just-in-time and the cleanup removes it again", async () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    saveTokens(makeTokens());
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {
      mkdirSync(join(tempHome, ".codex"), { recursive: true });
      writeFileSync(codexPath, "{}");
    });

    const cleanup = await prepareCodexAuthForBuild();
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(codexPath)).toBe(true);

    cleanup();
    expect(existsSync(codexPath)).toBe(false);
  });

  it("leaves a pre-existing ~/.codex/auth.json in place on cleanup (didn't create it)", async () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    saveTokens(makeTokens());
    mkdirSync(join(tempHome, ".codex"), { recursive: true });
    writeFileSync(codexPath, '{"pre":true}');
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {
      writeFileSync(codexPath, "{}");
    });

    const cleanup = await prepareCodexAuthForBuild();
    expect(mirrorSpy).toHaveBeenCalledTimes(1);

    cleanup();
    expect(existsSync(codexPath)).toBe(true);
  });

  it("is a no-op when hard-disabled (=0)", async () => {
    process.env.LAX_MIRROR_CODEX_AUTH = "0";
    saveTokens(makeTokens());
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {});

    const cleanup = await prepareCodexAuthForBuild();
    expect(mirrorSpy).not.toHaveBeenCalled();
    cleanup(); // must not throw
    expect(existsSync(codexPath)).toBe(false);
  });

  it("is a no-op under the persistent mirror (=1) — saveTokens already maintains the file", async () => {
    process.env.LAX_MIRROR_CODEX_AUTH = "1";
    saveTokens(makeTokens());
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {});

    const cleanup = await prepareCodexAuthForBuild();
    expect(mirrorSpy).not.toHaveBeenCalled();
    cleanup();
  });

  it("is a no-op when the stored tokens carry no id_token", async () => {
    delete process.env.LAX_MIRROR_CODEX_AUTH;
    saveTokens(makeTokens({ idToken: undefined }));
    const mirrorSpy = vi.spyOn(mirrorImpl, "fn").mockImplementation(() => {});

    const cleanup = await prepareCodexAuthForBuild();
    expect(mirrorSpy).not.toHaveBeenCalled();
    cleanup();
  });
});
