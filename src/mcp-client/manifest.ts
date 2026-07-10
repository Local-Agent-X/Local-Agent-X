import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";

import { verifyPublisherSignature } from "../plugin-system.js";
import { atomicWriteFileSync } from "../server-utils.js";
import { hashCommandBinary, resolveCommandPath } from "./integrity.js";
import type { MCPPackageIdentity, MCPServerConfig, MCPSignedManifest } from "./types.js";

const ACCEPTED_FILE = "mcp-signed-manifests.json";
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const HEX_256_RE = /^[a-f0-9]{64}$/i;
const SIGNATURE_RE = /^[a-f0-9]{128}$/i;
const ID_RE = /^[a-zA-Z0-9._-]+$/;
const PACKAGE_MANAGERS = new Set(["npx", "npm", "pnpm", "yarn", "bunx"]);

interface AcceptedManifest {
  version: string;
  digest: string;
  publisher: string;
  keyId: string | null;
  acceptedAt: string;
}

interface AcceptanceLedger {
  accepted: Record<string, AcceptedManifest>;
}

export type MCPManifestTrust = "verified" | "unsigned" | "unknown-publisher" | "invalid";

export interface MCPManifestAssessment {
  trust: MCPManifestTrust;
  publisher?: string;
  publisherName?: string;
  version?: string;
  keyId?: string | null;
  reason?: string;
  resolvedPath?: string;
  sha256?: string;
  manifestDigest?: string;
}

function stableConfig(config: MCPServerConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
}

export function mcpConfigFingerprint(config: MCPServerConfig): string {
  return createHash("sha256").update(stableConfig(config)).digest("hex");
}

export function mcpManifestPayload(manifest: Omit<MCPSignedManifest, "signature">): Buffer {
  const command = manifest.command.kind === "binary"
    ? { kind: "binary", resolvedPath: normalize(manifest.command.resolvedPath), sha256: manifest.command.sha256.toLowerCase() }
    : { kind: "package", manager: manifest.command.manager, name: manifest.command.name, version: manifest.command.version };
  return Buffer.from(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    serverName: manifest.serverName,
    version: manifest.version,
    publisher: manifest.publisher,
    ...(manifest.keyId ? { keyId: manifest.keyId } : {}),
    command,
    configFingerprint: manifest.configFingerprint.toLowerCase(),
    executionMode: manifest.executionMode,
  }), "utf8");
}

function ledgerPath(dataDir: string): string {
  return join(dataDir, ACCEPTED_FILE);
}

function loadLedger(dataDir: string): AcceptanceLedger {
  const path = ledgerPath(dataDir);
  if (!existsSync(path)) return { accepted: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AcceptanceLedger>;
    if (value.accepted && typeof value.accepted === "object") return { accepted: value.accepted };
  } catch (error) {
    throw new Error(`could not read signed-manifest acceptance ledger: ${(error as Error).message}`);
  }
  throw new Error("signed-manifest acceptance ledger is malformed");
}

function saveLedger(dataDir: string, ledger: AcceptanceLedger): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(ledgerPath(dataDir), JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
}

function compareVersions(a: string, b: string): number | null {
  const av = VERSION_RE.exec(a);
  const bv = VERSION_RE.exec(b);
  if (!av || !bv) return null;
  for (let i = 1; i <= 3; i++) {
    const delta = Number(av[i]) - Number(bv[i]);
    if (delta) return Math.sign(delta);
  }
  if (av[4] === bv[4]) return 0;
  if (!av[4]) return 1;
  if (!bv[4]) return -1;
  return av[4].localeCompare(bv[4], "en", { numeric: true });
}

function packageSpec(identity: MCPPackageIdentity): string {
  return `${identity.name}@${identity.version}`;
}

function packageIdentityMatches(config: MCPServerConfig, identity: MCPPackageIdentity): boolean {
  const commandName = basename(config.command).replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
  if (commandName !== identity.manager) return false;
  const args = config.args ?? [];
  const wanted = packageSpec(identity);
  if (identity.manager === "npm") {
    const execIndex = args.indexOf("exec");
    return execIndex >= 0 && args.slice(execIndex + 1).includes(wanted);
  }
  return args.includes(wanted);
}

function malformedReason(name: string, config: MCPServerConfig, manifest: MCPSignedManifest): string | null {
  if (manifest.schemaVersion !== 1) return "unsupported manifest schemaVersion";
  if (typeof manifest.serverName !== "string" || manifest.serverName !== name) return "manifest server name does not match configuration";
  if (typeof manifest.version !== "string" || !VERSION_RE.test(manifest.version)) return "manifest version must be semantic versioning";
  if (typeof manifest.publisher !== "string" || !ID_RE.test(manifest.publisher)) return "invalid publisher identifier";
  if (manifest.keyId !== undefined && (typeof manifest.keyId !== "string" || !ID_RE.test(manifest.keyId))) return "invalid publisher key identifier";
  if (typeof manifest.configFingerprint !== "string" || !HEX_256_RE.test(manifest.configFingerprint)) return "invalid config fingerprint";
  if (typeof manifest.signature !== "string" || !SIGNATURE_RE.test(manifest.signature)) return "invalid Ed25519 signature encoding";
  if (manifest.executionMode !== (config.executionMode ?? "sandboxed")) return "manifest execution posture does not match configuration";
  if (!manifest.command || typeof manifest.command !== "object") return "invalid command identity";
  if (manifest.command.kind === "binary") {
    if (typeof manifest.command.resolvedPath !== "string" || !manifest.command.resolvedPath || typeof manifest.command.sha256 !== "string" || !HEX_256_RE.test(manifest.command.sha256)) return "invalid binary identity";
  } else if (manifest.command.kind === "package") {
    if (!PACKAGE_MANAGERS.has(manifest.command.manager) || typeof manifest.command.name !== "string" || !manifest.command.name || typeof manifest.command.version !== "string" || !VERSION_RE.test(manifest.command.version)) return "invalid package identity";
  } else {
    return "unsupported command identity";
  }
  return null;
}

export function assessMcpManifest(
  dataDir: string,
  name: string,
  config: MCPServerConfig,
  options: { recordAcceptance?: boolean } = {},
): MCPManifestAssessment {
  const manifest = config.manifest;
  if (!manifest) {
    try {
      const previous = loadLedger(dataDir).accepted[name];
      return previous
        ? { trust: "invalid", publisher: previous.publisher, version: previous.version, reason: `signed manifest required; highest accepted version is ${previous.version}` }
        : { trust: "unsigned" };
    } catch (error) {
      return { trust: "invalid", reason: (error as Error).message };
    }
  }

  const malformed = malformedReason(name, config, manifest);
  if (malformed) return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: malformed };
  const expectedFingerprint = mcpConfigFingerprint(config);
  if (manifest.configFingerprint.toLowerCase() !== expectedFingerprint) {
    return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: "arguments or configuration do not match the signed fingerprint" };
  }

  const resolvedPath = resolveCommandPath(config.command);
  if (!resolvedPath) return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: "command not found on PATH" };
  let sha256: string;
  try {
    sha256 = hashCommandBinary(resolvedPath);
  } catch (error) {
    return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: `could not hash command: ${(error as Error).message}` };
  }

  if (manifest.command.kind === "binary") {
    if (resolve(manifest.command.resolvedPath) !== resolve(resolvedPath)) {
      return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: "resolved command path does not match signed manifest", resolvedPath, sha256 };
    }
    if (manifest.command.sha256.toLowerCase() !== sha256) {
      return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: "command hash does not match signed manifest", resolvedPath, sha256 };
    }
  } else if (!packageIdentityMatches(config, manifest.command)) {
    return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: "configured package identity does not match signed manifest", resolvedPath, sha256 };
  }

  const { signature, ...unsigned } = manifest;
  const payload = mcpManifestPayload(unsigned);
  const digest = createHash("sha256").update(payload).digest("hex");
  const signatureVerdict = verifyPublisherSignature(manifest.publisher, payload, signature, manifest.keyId);
  if (signatureVerdict.status === "unknown-publisher") {
    try {
      const previous = loadLedger(dataDir).accepted[name];
      if (previous) {
        return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: `previously accepted publisher ${previous.publisher} can no longer be verified`, resolvedPath, sha256, manifestDigest: digest };
      }
    } catch (error) {
      return { trust: "invalid", publisher: manifest.publisher, version: manifest.version, reason: (error as Error).message, resolvedPath, sha256, manifestDigest: digest };
    }
    return {
      trust: "unknown-publisher",
      publisher: manifest.publisher,
      version: manifest.version,
      keyId: manifest.keyId ?? null,
      reason: "publisher is not trusted",
      resolvedPath,
      sha256,
      manifestDigest: digest,
    };
  }
  if (signatureVerdict.status === "unknown-key") {
    return { trust: "invalid", publisher: manifest.publisher, publisherName: signatureVerdict.publisher.name, version: manifest.version, keyId: manifest.keyId ?? null, reason: "publisher key is not trusted", resolvedPath, sha256, manifestDigest: digest };
  }
  if (signatureVerdict.status !== "valid") {
    return { trust: "invalid", publisher: manifest.publisher, publisherName: signatureVerdict.publisher.name, version: manifest.version, keyId: manifest.keyId ?? null, reason: "publisher signature is invalid", resolvedPath, sha256, manifestDigest: digest };
  }

  let ledger: AcceptanceLedger;
  try {
    ledger = loadLedger(dataDir);
  } catch (error) {
    return { trust: "invalid", publisher: manifest.publisher, publisherName: signatureVerdict.publisher.name, version: manifest.version, reason: (error as Error).message, resolvedPath, sha256, manifestDigest: digest };
  }
  const previous = ledger.accepted[name];
  if (previous) {
    if (previous.publisher !== manifest.publisher) {
      return { trust: "invalid", publisher: manifest.publisher, publisherName: signatureVerdict.publisher.name, version: manifest.version, reason: `publisher does not match previously accepted publisher ${previous.publisher}`, resolvedPath, sha256, manifestDigest: digest };
    }
    const comparison = compareVersions(manifest.version, previous.version);
    if (comparison === null || comparison < 0) {
      return { trust: "invalid", publisher: manifest.publisher, publisherName: signatureVerdict.publisher.name, version: manifest.version, reason: `signed manifest downgrade blocked; highest accepted version is ${previous.version}`, resolvedPath, sha256, manifestDigest: digest };
    }
    if (comparison === 0 && previous.digest !== digest) {
      return { trust: "invalid", publisher: manifest.publisher, publisherName: signatureVerdict.publisher.name, version: manifest.version, reason: "different signed manifest reuses an accepted version", resolvedPath, sha256, manifestDigest: digest };
    }
  }

  if (options.recordAcceptance && (!previous || previous.digest !== digest)) {
    ledger.accepted[name] = {
      version: manifest.version,
      digest,
      publisher: manifest.publisher,
      keyId: manifest.keyId ?? null,
      acceptedAt: new Date().toISOString(),
    };
    saveLedger(dataDir, ledger);
  }
  return { trust: "verified", publisher: manifest.publisher, publisherName: signatureVerdict.publisher.name, version: manifest.version, keyId: manifest.keyId ?? null, resolvedPath, sha256, manifestDigest: digest };
}

export function __mcpManifestLedgerPathForTests(dataDir: string): string {
  return ledgerPath(dataDir);
}
