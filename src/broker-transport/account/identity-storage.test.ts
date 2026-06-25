// fs-backed tests for identity + storage. Both read ~/.lax via getLaxDir(), which
// honors LAX_DATA_DIR — so we point it at a fresh temp dir per run and assert the
// round-trips. No network, no real home dir touched.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateDeviceIdentity, loadDeviceIdentity } from "./identity.js";
import { saveAccountState, loadAccountState, updateAccountState, clearAccountState } from "./storage.js";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axos-acct-"));
  prev = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("device identity", () => {
  it("generates an ed25519 keypair on first call and reuses it after", () => {
    const first = getOrCreateDeviceIdentity();
    expect(first.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(first.privateKey).toContain("BEGIN PRIVATE KEY");
    const second = getOrCreateDeviceIdentity();
    expect(second).toEqual(first); // stable across calls
    expect(loadDeviceIdentity()).toEqual(first);
  });
});

describe("account storage", () => {
  it("round-trips, merges, and clears the account state", () => {
    expect(loadAccountState()).toBeNull();

    saveAccountState({ email: "a@b.co", sessionToken: "tok", deviceId: "dev-1" });
    expect(loadAccountState()).toEqual({ email: "a@b.co", sessionToken: "tok", deviceId: "dev-1", pairedPhoneId: undefined });

    const merged = updateAccountState({ pairedPhoneId: "phone-9" });
    expect(merged?.pairedPhoneId).toBe("phone-9");
    expect(loadAccountState()?.pairedPhoneId).toBe("phone-9");

    clearAccountState();
    expect(loadAccountState()).toBeNull();
    expect(existsSync(join(dir, "agentxos-account.json"))).toBe(false);
  });

  it("updateAccountState is a no-op (null) when signed out", () => {
    expect(updateAccountState({ pairedPhoneId: "x" })).toBeNull();
  });
});
