import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertKeyRecoverySafe, MASTER_KEY_DEPENDENT_BASENAMES } from "../src/secrets-crypto.js";

describe("master-key recovery dependents", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-key-recovery-"));
  });

  afterEach(() => {
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(["auth.json", "anthropic-auth.json", "xai-auth.json"])(
    "refuses synthetic macOS recovery when %s depends on the old key",
    (filename) => {
      writeFileSync(join(dataDir, filename), '{"format":"lax-auth-v2"}');
      expect(() => assertKeyRecoverySafe(dataDir, "macOS Keychain", "synthetic retrieval failure"))
        .toThrow(filename);
    },
  );

  it("refuses synthetic libsecret recovery when only an auth envelope exists", () => {
    writeFileSync(join(dataDir, "xai-auth.json"), '{"format":"lax-auth-v2"}');
    expect(() => assertKeyRecoverySafe(dataDir, "libsecret", "synthetic retrieval failure"))
      .toThrow(/Refusing to auto-regenerate/);
  });

  it("refuses synthetic key recovery when audit-key.enc depends on the old key", () => {
    writeFileSync(join(dataDir, "audit-key.enc"), "{}");
    expect(() => assertKeyRecoverySafe(dataDir, "libsecret", "synthetic retrieval failure"))
      .toThrow(/audit-key\.enc/);
  });

  it("permits initialization when no encrypted dependent exists", () => {
    expect(() => assertKeyRecoverySafe(dataDir, "libsecret", "missing entry")).not.toThrow();
  });

  it("does not treat legacy plaintext auth as key-dependent", () => {
    writeFileSync(join(dataDir, "auth.json"), '{"accessToken":"legacy"}');
    expect(() => assertKeyRecoverySafe(dataDir, "libsecret", "missing entry")).not.toThrow();
  });

  it("conservatively recognizes future versioned auth envelopes", () => {
    writeFileSync(join(dataDir, "auth.json"), '{"format":"lax-auth-v9"}');
    expect(() => assertKeyRecoverySafe(dataDir, "DPAPI", "synthetic retrieval failure"))
      .toThrow(/auth\.json/);
  });

  it("enumerates the vault and every auth envelope basename", () => {
    expect(MASTER_KEY_DEPENDENT_BASENAMES).toEqual([
      "secrets.enc", "audit-key.enc", "auth.json", "anthropic-auth.json", "xai-auth.json",
    ]);
  });
});
