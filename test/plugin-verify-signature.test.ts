import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

// plugin-system.ts captures PLUGINS_DIR and TRUSTED_PUBLISHERS_PATH at
// module-load from getLaxDir(), which honors LAX_DATA_DIR. So we set
// LAX_DATA_DIR to a fresh tempdir BEFORE importing the module (dynamic
// import + vi.resetModules per test), then drive the private
// verifySignature() through the public PluginManager.loadPlugin surface:
// a valid signature yields trustLevel "signed"; a tampered body or bad
// signature makes assessTrustLevel throw "invalid signature".

let tmpRoot: string;
let pluginsDir: string;
let prevDataDir: string | undefined;

// A throwaway Ed25519 keypair, regenerated per test.
let publicKeyHex: string;
let privateKey: KeyObject;

// Pull the raw 32-byte Ed25519 public key out of its SPKI DER wrapper.
// The wrapper has a fixed 12-byte prefix; the trailing 32 bytes are the key.
function rawPublicKeyHex(pub: KeyObject): string {
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(12).toString("hex");
}

// Build a plugin directory under PLUGINS_DIR with a manifest + entry file.
// Returns the plugin dir path.
function makePlugin(opts: {
  id: string;
  entryContent: string;
  signature?: string;
  publisher?: string;
}): string {
  const dir = join(pluginsDir, opts.id);
  mkdirSync(dir, { recursive: true });
  const entryFile = "index.mjs";
  writeFileSync(join(dir, entryFile), opts.entryContent, "utf-8");
  const manifest: Record<string, unknown> = {
    id: opts.id,
    name: opts.id,
    version: "1.0.0",
    description: "test plugin",
    entryPoint: entryFile,
    tools: [],
  };
  if (opts.signature !== undefined) manifest.signature = opts.signature;
  if (opts.publisher !== undefined) manifest.publisher = opts.publisher;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return dir;
}

function writeTrustedPublishers(map: Record<string, { name: string; publicKey: string }>): void {
  writeFileSync(join(tmpRoot, "trusted-publishers.json"), JSON.stringify(map, null, 2), "utf-8");
}

function writePluginRegistry(registry: Record<string, { enabled: boolean; path: string; entryHash?: string }>): void {
  writeFileSync(join(pluginsDir, "registry.json"), JSON.stringify(registry, null, 2), "utf-8");
}

function signContent(content: string): string {
  return sign(null, Buffer.from(content, "utf-8"), privateKey).toString("hex");
}

// Fresh module per test so PLUGINS_DIR / TRUSTED_PUBLISHERS_PATH are
// recomputed against the current LAX_DATA_DIR.
async function freshPluginManager() {
  vi.resetModules();
  const { PluginManager } = await import("../src/plugin-system.js");
  return new PluginManager();
}

beforeEach(() => {
  // realpathSync collapses symlinks (e.g. macOS /tmp -> /private/tmp) so the
  // path matches loadPlugin's realpathSync(PLUGINS_DIR) confinement check.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "lax-plugin-sig-")));
  pluginsDir = join(tmpRoot, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tmpRoot;

  const kp = generateKeyPairSync("ed25519");
  privateKey = kp.privateKey;
  publicKeyHex = rawPublicKeyHex(kp.publicKey);
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("verifySignature via PluginManager.loadPlugin", () => {
  const ENTRY = "export const id = 'ok';\n";

  it("accepts a valid signature from a trusted publisher (trustLevel 'signed')", async () => {
    writeTrustedPublishers({ acme: { name: "ACME", publicKey: publicKeyHex } });
    const dir = makePlugin({
      id: "valid-plugin",
      entryContent: ENTRY,
      signature: signContent(ENTRY),
      publisher: "acme",
    });

    const pm = await freshPluginManager();
    const manifest = await pm.loadPlugin(dir);
    expect(manifest.id).toBe("valid-plugin");
    expect(pm.getPluginTrust("valid-plugin")).toBe("signed");
  });

  it("rejects when the entry body was tampered after signing", async () => {
    writeTrustedPublishers({ acme: { name: "ACME", publicKey: publicKeyHex } });
    // Sign the original content, but ship a different body on disk.
    const goodSig = signContent(ENTRY);
    const dir = makePlugin({
      id: "tampered-body",
      entryContent: ENTRY + "// injected payload\n",
      signature: goodSig,
      publisher: "acme",
    });

    const pm = await freshPluginManager();
    await expect(pm.loadPlugin(dir)).rejects.toThrow(/invalid signature/i);
    expect(pm.isLoaded("tampered-body")).toBe(false);
  });

  it("rejects a well-formed-hex signature signed by a DIFFERENT key", async () => {
    // Publisher key on file is the real one; sign with an unrelated key.
    writeTrustedPublishers({ acme: { name: "ACME", publicKey: publicKeyHex } });
    const other = generateKeyPairSync("ed25519");
    const wrongSig = sign(null, Buffer.from(ENTRY, "utf-8"), other.privateKey).toString("hex");
    const dir = makePlugin({
      id: "wrong-key",
      entryContent: ENTRY,
      signature: wrongSig,
      publisher: "acme",
    });

    const pm = await freshPluginManager();
    await expect(pm.loadPlugin(dir)).rejects.toThrow(/invalid signature/i);
  });

  it("rejects a hex signature of the right length but all zeros (garbage bytes)", async () => {
    writeTrustedPublishers({ acme: { name: "ACME", publicKey: publicKeyHex } });
    const dir = makePlugin({
      id: "zero-sig",
      entryContent: ENTRY,
      signature: "00".repeat(64), // 128 hex chars, valid hex shape, not a real signature
      publisher: "acme",
    });

    const pm = await freshPluginManager();
    await expect(pm.loadPlugin(dir)).rejects.toThrow(/invalid signature/i);
  });

  it("rejects a non-hex (garbage) signature at manifest validation", async () => {
    writeTrustedPublishers({ acme: { name: "ACME", publicKey: publicKeyHex } });
    const dir = makePlugin({
      id: "garbage-sig",
      entryContent: ENTRY,
      signature: "not-a-hex-signature!!!",
      publisher: "acme",
    });

    const pm = await freshPluginManager();
    // validateManifest enforces /^[a-f0-9]+$/i on signature, so a garbage
    // string is rejected before reaching verifySignature.
    await expect(pm.loadPlugin(dir)).rejects.toThrow(/Invalid manifest/i);
  });

  it("treats a signed plugin from an UNKNOWN publisher as unsigned (not signed)", async () => {
    // No trusted-publishers.json entry for "acme": verifySignature is never
    // consulted; the plugin loads but is NOT elevated to "signed".
    writeTrustedPublishers({}); // empty registry
    const dir = makePlugin({
      id: "unknown-pub",
      entryContent: ENTRY,
      signature: signContent(ENTRY),
      publisher: "acme",
    });

    const pm = await freshPluginManager();
    const manifest = await pm.loadPlugin(dir);
    expect(manifest.id).toBe("unknown-pub");
    expect(pm.getPluginTrust("unknown-pub")).toBe("unsigned");
  });

  it("loads an unsigned plugin (no signature field) as 'unsigned' on first load", async () => {
    const dir = makePlugin({ id: "no-sig", entryContent: ENTRY });

    const pm = await freshPluginManager();
    const manifest = await pm.loadPlugin(dir);
    expect(manifest.id).toBe("no-sig");
    expect(pm.getPluginTrust("no-sig")).toBe("unsigned");
  });

  it("restores enabled plugins into a fresh lifecycle manager", async () => {
    const dir = makePlugin({ id: "restore-on-boot", entryContent: ENTRY });
    const installer = await freshPluginManager();
    await installer.loadPlugin(dir);

    const { PluginManager } = await import("../src/plugin-system.js");
    const bootManager = new PluginManager();
    const restored = await bootManager.loadAllEnabled();

    expect(restored.map((plugin) => plugin.id)).toEqual(["restore-on-boot"]);
    expect(bootManager.isLoaded("restore-on-boot")).toBe(true);
    expect(bootManager.listPlugins()).toHaveLength(1);
  });

  it("does not execute an enabled plugin without a persisted integrity pin at boot", async () => {
    const marker = join(tmpRoot, "unpinned-executed.txt");
    const dir = makePlugin({
      id: "unpinned",
      entryContent: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    });
    writePluginRegistry({ unpinned: { enabled: true, path: dir } });

    const pm = await freshPluginManager();
    expect(await pm.loadAllEnabled()).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({
        id: "unpinned",
        enabled: true,
        status: "failed",
        error: "Plugin is not integrity-pinned",
      }),
    ]);
  });

  it("keeps a tampered enabled plugin visible and allows disabling it", async () => {
    const dir = makePlugin({ id: "tampered-on-boot", entryContent: ENTRY });
    const installer = await freshPluginManager();
    await installer.loadPlugin(dir);
    writeFileSync(join(dir, "index.mjs"), ENTRY + "// changed after pinning\n", "utf-8");

    const { PluginManager } = await import("../src/plugin-system.js");
    const bootManager = new PluginManager();
    expect(await bootManager.loadAllEnabled()).toEqual([]);
    expect(bootManager.listPlugins()).toEqual([
      expect.objectContaining({
        id: "tampered-on-boot",
        enabled: true,
        status: "failed",
        error: "Integrity verification failed",
      }),
    ]);

    expect(bootManager.disablePlugin("tampered-on-boot")).toBe(true);
    expect(bootManager.listPlugins()).toEqual([
      expect.objectContaining({ id: "tampered-on-boot", enabled: false, status: "disabled" }),
    ]);
  });

  it("binds a restored registry key to the manifest identity before import", async () => {
    const marker = join(tmpRoot, "alias-executed.txt");
    const entryContent = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`;
    const dir = makePlugin({ id: "payload", entryContent });
    writePluginRegistry({
      alias: {
        enabled: true,
        path: dir,
        entryHash: createHash("sha256").update(entryContent).digest("hex"),
      },
    });

    const pm = await freshPluginManager();
    expect(await pm.loadAllEnabled()).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({
        id: "alias",
        enabled: true,
        status: "failed",
        error: "Registry identity does not match manifest",
      }),
    ]);

    const registry = JSON.parse(readFileSync(join(pluginsDir, "registry.json"), "utf-8")) as Record<string, unknown>;
    expect(registry.payload).toBeUndefined();
    expect(pm.disablePlugin("alias")).toBe(true);
    expect(pm.listPlugins()).toEqual([
      expect.objectContaining({ id: "alias", enabled: false, status: "disabled" }),
    ]);
  });
});
