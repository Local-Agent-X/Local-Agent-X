import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression: email-config's vault() must read the SAME module instance of
 * secrets.ts that the server's bootstrap writes to.
 *
 * It used to load ../secrets.js through createRequire(). `_secretsStoreSingleton`
 * is a module-level variable, so a createRequire() load is a SEPARATE instance
 * from the ESM graph: bootstrap set the singleton on one, vault() read the other
 * and got null. Every password lookup failed in the dev server while the vault
 * itself was perfectly healthy — email_setup reported "Secret 'SMTP_PASS' is not
 * in the vault" seconds after the secret had been saved successfully.
 *
 * Nothing caught it because every email test injects a store or fakes the config
 * layer. This test deliberately goes through the REAL singleton wiring instead.
 */
describe("email-config vault() reads the singleton bootstrap actually sets", () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.LAX_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), "lax-vault-wiring-"));
    process.env.LAX_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a secret set through the ESM singleton, not undefined", async () => {
    const secrets = await import("../secrets.js");
    const { vault } = await import("./email-config.js");

    // Exactly what bootstrap-services does: construct a store and register it.
    const store = new secrets.SecretsStore(dir);
    secrets.setSecretsStoreSingleton(store);
    store.set("SMTP_PASS", "app-password-16ch", "Gmail");

    // Sanity: the store itself holds it. If this fails the test is wrong, not the code.
    expect(store.get("SMTP_PASS")).toBe("app-password-16ch");

    // The actual regression. Under the createRequire() version this was undefined,
    // because vault() was reading a second, never-initialised module instance.
    expect(vault("SMTP_PASS")).toBe("app-password-16ch");
  });

  it("still returns undefined for a name that was never stored", async () => {
    const secrets = await import("../secrets.js");
    const { vault } = await import("./email-config.js");

    const store = new secrets.SecretsStore(dir);
    secrets.setSecretsStoreSingleton(store);

    expect(vault("NEVER_SET")).toBeUndefined();
  });

  it("resolves a full SMTP config once the password is reachable", async () => {
    const secrets = await import("../secrets.js");
    const { vault, writeEmailJson, getSmtpConfig } = await import("./email-config.js");

    const store = new secrets.SecretsStore(dir);
    secrets.setSecretsStoreSingleton(store);
    store.set("SMTP_PASS", "app-password-16ch", "Gmail");
    writeEmailJson({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "587",
      SMTP_USER: "someone@gmail.com",
      SMTP_FROM: "someone@gmail.com",
    });

    expect(vault("SMTP_PASS")).toBe("app-password-16ch");

    // The user-visible symptom: with the password unreachable this returned the
    // "Email not configured" STRING, which hides email_send behind its
    // availability predicate — so the agent could not send OR see the tool.
    const cfg = getSmtpConfig();
    expect(typeof cfg).not.toBe("string");
    if (typeof cfg !== "string") {
      expect(cfg.host).toBe("smtp.gmail.com");
      expect(cfg.pass).toBe("app-password-16ch");
    }
  });
});
