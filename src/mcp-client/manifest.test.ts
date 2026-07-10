import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MCPServerConfig, MCPSignedManifest } from "./types.js";

let dataDir: string;
let binaryPath: string;
let previousDataDir: string | undefined;
let privateKey: KeyObject;
let publicKeyHex: string;
let manifestApi: typeof import("./manifest.js");
let integrityApi: typeof import("./integrity.js");
let connectionApi: typeof import("./connection.js");

function rawPublicKeyHex(key: KeyObject): string {
  const spki = key.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(12).toString("hex");
}

function writePublishers(value: Record<string, unknown>): void {
  writeFileSync(join(dataDir, "trusted-publishers.json"), JSON.stringify(value, null, 2));
}

function unsignedManifest(
  name: string,
  config: MCPServerConfig,
  version = "1.0.0",
  overrides: Partial<Omit<MCPSignedManifest, "signature">> = {},
): Omit<MCPSignedManifest, "signature"> {
  return {
    schemaVersion: 1,
    serverName: name,
    version,
    publisher: "acme",
    command: {
      kind: "binary",
      resolvedPath: binaryPath,
      sha256: integrityApi.hashCommandBinary(binaryPath),
    },
    configFingerprint: manifestApi.mcpConfigFingerprint(config),
    executionMode: config.executionMode ?? "sandboxed",
    ...overrides,
  };
}

function signedManifest(
  name: string,
  config: MCPServerConfig,
  version = "1.0.0",
  key: KeyObject = privateKey,
  overrides: Partial<Omit<MCPSignedManifest, "signature">> = {},
): MCPSignedManifest {
  const unsigned = unsignedManifest(name, config, version, overrides);
  return { ...unsigned, signature: sign(null, manifestApi.mcpManifestPayload(unsigned), key).toString("hex") };
}

beforeEach(async () => {
  vi.resetModules();
  previousDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "lax-mcp-manifest-"));
  process.env.LAX_DATA_DIR = dataDir;
  binaryPath = join(dataDir, process.platform === "win32" ? "server.exe" : "server");
  writeFileSync(binaryPath, "signed mcp binary v1\n", { mode: 0o755 });
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  publicKeyHex = rawPublicKeyHex(pair.publicKey);
  writePublishers({ acme: { name: "ACME", publicKey: publicKeyHex } });
  manifestApi = await import("./manifest.js");
  integrityApi = await import("./integrity.js");
  connectionApi = await import("./connection.js");
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  connectionApi.__setMcpSandboxBackendForTests(undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("signed MCP publisher manifests", () => {
  it("verifies a valid known-publisher signature without creating TOFU state", () => {
    const config: MCPServerConfig = { command: binaryPath, args: ["--stdio"], executionMode: "trusted" };
    config.manifest = signedManifest("acme-server", config);

    const result = manifestApi.assessMcpManifest(dataDir, "acme-server", config, { recordAcceptance: true });

    expect(result).toMatchObject({ trust: "verified", publisher: "acme", publisherName: "ACME", version: "1.0.0" });
    expect(connectionApi.getMcpExecutionPosture(config, false, true).effective).toBe("trusted");
    expect(() => integrityApi.loadTrustStore()).not.toThrow();
    expect(integrityApi.loadTrustStore()).toEqual({});
  });

  it("fails closed for a tampered binary, signed manifest body, or args", () => {
    const base: MCPServerConfig = { command: binaryPath, args: ["--stdio"], executionMode: "sandboxed" };
    const manifest = signedManifest("tamper", base);

    writeFileSync(binaryPath, "tampered binary\n", { mode: 0o755 });
    expect(manifestApi.assessMcpManifest(dataDir, "tamper", { ...base, manifest }).reason).toMatch(/command hash/);

    writeFileSync(binaryPath, "signed mcp binary v1\n", { mode: 0o755 });
    expect(manifestApi.assessMcpManifest(dataDir, "tamper", {
      ...base,
      manifest: { ...manifest, version: "1.0.1" },
    }).reason).toMatch(/signature is invalid/);

    expect(manifestApi.assessMcpManifest(dataDir, "tamper", {
      ...base,
      args: ["--stdio", "--exfiltrate"],
      manifest,
    }).reason).toMatch(/arguments or configuration/);
  });

  it("does not authorize a manifest from an unknown publisher", () => {
    const config: MCPServerConfig = { command: binaryPath, executionMode: "trusted" };
    config.manifest = signedManifest("unknown", config, "1.0.0", privateKey, { publisher: "unlisted" });

    const result = manifestApi.assessMcpManifest(dataDir, "unknown", config);

    expect(result).toMatchObject({ trust: "unknown-publisher", publisher: "unlisted" });
    expect(connectionApi.getMcpExecutionPosture(config, false, false).effective).toBe("blocked");
    expect(connectionApi.getMcpExecutionPosture(config, true, false).effective).toBe("trusted");
  });

  it("fails closed for an unknown key on a known publisher and malformed API input", () => {
    writePublishers({ acme: { name: "ACME", publicKeys: { current: publicKeyHex } } });
    const config: MCPServerConfig = { command: binaryPath, executionMode: "sandboxed" };
    config.manifest = signedManifest("bad-key", config, "1.0.0", privateKey, { keyId: "retired" });
    expect(manifestApi.assessMcpManifest(dataDir, "bad-key", config)).toMatchObject({ trust: "invalid", reason: "publisher key is not trusted" });

    const malformed = {
      schemaVersion: 1,
      serverName: "malformed",
      version: "1.0.0",
      publisher: "acme",
      command: null,
      configFingerprint: "0".repeat(64),
      executionMode: "sandboxed",
      signature: "0".repeat(128),
    } as unknown as MCPSignedManifest;
    expect(() => manifestApi.assessMcpManifest(dataDir, "malformed", { command: binaryPath, manifest: malformed })).not.toThrow();
    expect(manifestApi.assessMcpManifest(dataDir, "malformed", { command: binaryPath, manifest: malformed }).trust).toBe("invalid");
  });

  it("accepts a valid upgrade signed by a rotated named key", () => {
    const oldPair = generateKeyPairSync("ed25519");
    const newPair = generateKeyPairSync("ed25519");
    writePublishers({
      acme: {
        name: "ACME",
        publicKeys: {
          old: rawPublicKeyHex(oldPair.publicKey),
          current: rawPublicKeyHex(newPair.publicKey),
        },
      },
    });
    const config: MCPServerConfig = { command: binaryPath, executionMode: "trusted" };
    config.manifest = signedManifest("rotated", config, "1.0.0", oldPair.privateKey, { keyId: "old" });
    expect(manifestApi.assessMcpManifest(dataDir, "rotated", config, { recordAcceptance: true }).trust).toBe("verified");

    writeFileSync(binaryPath, "signed mcp binary v2\n", { mode: 0o755 });
    config.manifest = signedManifest("rotated", config, "2.0.0", newPair.privateKey, { keyId: "current" });
    expect(manifestApi.assessMcpManifest(dataDir, "rotated", config, { recordAcceptance: true })).toMatchObject({ trust: "verified", keyId: "current", version: "2.0.0" });
  });

  it("blocks replayed downgrades and same-version manifest substitution", () => {
    const config: MCPServerConfig = { command: binaryPath, args: ["--stdio"], executionMode: "trusted" };
    const v1 = signedManifest("versions", config, "1.0.0");
    config.manifest = v1;
    expect(manifestApi.assessMcpManifest(dataDir, "versions", config, { recordAcceptance: true }).trust).toBe("verified");

    const v2 = signedManifest("versions", config, "2.0.0");
    config.manifest = v2;
    expect(manifestApi.assessMcpManifest(dataDir, "versions", config, { recordAcceptance: true }).trust).toBe("verified");

    config.manifest = v1;
    expect(manifestApi.assessMcpManifest(dataDir, "versions", config)).toMatchObject({ trust: "invalid", reason: expect.stringMatching(/downgrade/) });

    const alternateV2 = signedManifest("versions", config, "2.0.0", privateKey, { keyId: "alternate" });
    writePublishers({ acme: { name: "ACME", publicKeys: { alternate: publicKeyHex } } });
    config.manifest = alternateV2;
    expect(manifestApi.assessMcpManifest(dataDir, "versions", config)).toMatchObject({ trust: "invalid", reason: expect.stringMatching(/reuses an accepted version/) });
  });

  it("does not reopen fallback trust when an accepted signature or publisher is stripped", () => {
    const config: MCPServerConfig = { command: binaryPath, executionMode: "sandboxed" };
    config.manifest = signedManifest("sticky-signed", config);
    expect(manifestApi.assessMcpManifest(dataDir, "sticky-signed", config, { recordAcceptance: true }).trust).toBe("verified");

    expect(manifestApi.assessMcpManifest(dataDir, "sticky-signed", { ...config, manifest: undefined })).toMatchObject({ trust: "invalid", reason: expect.stringMatching(/signed manifest required/) });
    writePublishers({});
    expect(manifestApi.assessMcpManifest(dataDir, "sticky-signed", config)).toMatchObject({ trust: "invalid", reason: expect.stringMatching(/can no longer be verified/) });
  });

  it("fails closed when persisted anti-downgrade state is malformed", () => {
    const config: MCPServerConfig = { command: binaryPath, executionMode: "trusted" };
    config.manifest = signedManifest("ledger", config);
    expect(manifestApi.assessMcpManifest(dataDir, "ledger", config, { recordAcceptance: true }).trust).toBe("verified");
    writeFileSync(manifestApi.__mcpManifestLedgerPathForTests(dataDir), "{broken");
    expect(manifestApi.assessMcpManifest(dataDir, "ledger", config)).toMatchObject({ trust: "invalid", reason: expect.stringMatching(/acceptance ledger/) });
  });

  it("keeps unsigned trusted execution on the explicit local-trust fallback", () => {
    const config: MCPServerConfig = { command: binaryPath, executionMode: "trusted" };
    expect(manifestApi.assessMcpManifest(dataDir, "local-only", config).trust).toBe("unsigned");
    expect(connectionApi.getMcpExecutionPosture(config, false, false).effective).toBe("blocked");
    expect(connectionApi.getMcpExecutionPosture(config, true, false).effective).toBe("trusted");
  });
});
