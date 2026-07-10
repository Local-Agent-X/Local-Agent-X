import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve, win32 } from "node:path";
import { getOrCreateMasterKey } from "../keychain.js";
import { createLogger } from "../logger.js";
import { writeSecretFileAtomic } from "./secret-file.js";

const logger = createLogger("auth-storage");

export const ENVELOPE_FORMAT = "lax-auth-v2" as const;
export const LEGACY_ENVELOPE_FORMAT = "lax-auth-v1" as const;
export const PROBE_CREDENTIAL_PATH_ENV = "LAX_PROBE_PROVIDER_AUTH_PATH" as const;

export type ProviderCredentialNamespace = "core" | "anthropic" | "xai";

interface Envelope {
  format: typeof ENVELOPE_FORMAT | typeof LEGACY_ENVELOPE_FORMAT;
  iv: string;
  ciphertext: string;
  tag: string;
}

type CredentialFormat = "v2" | "v2-basename" | "v1" | "plaintext";
type JsonRecord = Record<string, unknown>;

let _cachedKey: Buffer | null = null;

function resolveMasterKey(dataDir: string): Buffer {
  const key = _cachedKey ?? getOrCreateMasterKey(dataDir).key;
  if (key.length !== 32) {
    throw new Error(`auth-storage: master key must be 32 bytes, got ${key.length}`);
  }
  _cachedKey = key;
  return key;
}

export function _resetMasterKeyCacheForTests(): void {
  _cachedKey = null;
}

export function _setMasterKeyCacheForTests(key: Buffer): void {
  _cachedKey = key;
}

function parseEnvelope(envelopeJson: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch (e) {
    throw new Error(`auth-storage: envelope is not valid JSON: ${(e as Error).message}`);
  }
  if (!isEnvelope(parsed)) {
    throw new Error("auth-storage: envelope is missing required fields (format/iv/ciphertext/tag)");
  }
  return parsed;
}

function isEnvelope(value: unknown): value is Envelope {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    (value.format === ENVELOPE_FORMAT || value.format === LEGACY_ENVELOPE_FORMAT) &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.tag === "string"
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialAad(namespace: ProviderCredentialNamespace, authPath: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(authPath) || authPath.startsWith("\\\\");
  const absolute = windowsPath ? win32.resolve(authPath) : resolve(authPath);
  const normalized = absolute.replace(/\\/g, "/");
  const canonicalPath = windowsPath || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
  return `${ENVELOPE_FORMAT}\n${namespace}\n${canonicalPath}`;
}

function basenameCredentialAad(namespace: ProviderCredentialNamespace, authPath: string): string {
  const filename = /^[A-Za-z]:[\\/]/.test(authPath) || authPath.startsWith("\\\\")
    ? win32.basename(authPath)
    : basename(authPath);
  return `${ENVELOPE_FORMAT}\n${namespace}\n${filename}`;
}

export function _credentialAadForTests(
  namespace: ProviderCredentialNamespace,
  authPath: string,
): string {
  return credentialAad(namespace, authPath);
}

export function encryptWithKey(plaintext: string, key: Buffer, aad = ""): string {
  if (key.length !== 32) {
    throw new Error(`auth-storage: encryption key must be 32 bytes, got ${key.length}`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const envelope: Envelope = {
    format: ENVELOPE_FORMAT,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function _encryptV1WithKeyForTests(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("auth-storage: encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return JSON.stringify({
    format: LEGACY_ENVELOPE_FORMAT,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  });
}

export function _encryptBasenameBoundV2ForTests(
  plaintext: string,
  key: Buffer,
  namespace: ProviderCredentialNamespace,
  authPath: string,
): string {
  return encryptWithKey(plaintext, key, basenameCredentialAad(namespace, authPath));
}

export function decryptWithKey(envelopeJson: string, key: Buffer, aad = ""): string {
  if (key.length !== 32) {
    throw new Error(`auth-storage: decryption key must be 32 bytes, got ${key.length}`);
  }
  const envelope = parseEnvelope(envelopeJson);
  const iv = Buffer.from(envelope.iv, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== 12) throw new Error(`auth-storage: iv must be 12 bytes, got ${iv.length}`);
  if (tag.length !== 16) throw new Error(`auth-storage: tag must be 16 bytes, got ${tag.length}`);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (envelope.format === ENVELOPE_FORMAT) decipher.setAAD(Buffer.from(aad, "utf-8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

export function encryptAuthBlob(
  plaintext: string,
  dataDir: string,
  namespace: ProviderCredentialNamespace = "core",
  authPath = `${dataDir}/auth.json`,
): string {
  return encryptWithKey(plaintext, resolveMasterKey(dataDir), credentialAad(namespace, authPath));
}

export function decryptAuthBlob(
  blob: string,
  dataDir: string,
  namespace: ProviderCredentialNamespace = "core",
  authPath = `${dataDir}/auth.json`,
): { plaintext: string; wasEncrypted: boolean; format: CredentialFormat } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch (e) {
    throw new Error(`auth-storage: input is not valid JSON: ${(e as Error).message}`);
  }
  if (isRecord(parsed) && typeof parsed.accessToken === "string") {
    return { plaintext: blob, wasEncrypted: false, format: "plaintext" };
  }
  if (!isEnvelope(parsed)) {
    throw new Error("auth-storage: blob is neither legacy plaintext nor a recognized envelope");
  }
  const key = resolveMasterKey(dataDir);
  if (parsed.format === LEGACY_ENVELOPE_FORMAT) {
    return {
      plaintext: decryptWithKey(blob, key),
      wasEncrypted: true,
      format: "v1",
    };
  }
  try {
    return {
      plaintext: decryptWithKey(blob, key, credentialAad(namespace, authPath)),
      wasEncrypted: true,
      format: "v2",
    };
  } catch (fullPathError) {
    try {
      return {
        plaintext: decryptWithKey(blob, key, basenameCredentialAad(namespace, authPath)),
        wasEncrypted: true,
        format: "v2-basename",
      };
    } catch {
      throw fullPathError;
    }
  }
}

function assertAllowedKeys(value: JsonRecord, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`auth-storage: unexpected credential fields: ${unknown.join(", ")}`);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validateCredentials(namespace: ProviderCredentialNamespace, value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("auth-storage: credentials must be a JSON object");
  if (typeof value.accessToken !== "string" || value.accessToken.length === 0) {
    throw new Error("auth-storage: credentials require a non-empty accessToken");
  }
  if (namespace === "core") {
    assertAllowedKeys(value, ["accessToken", "refreshToken", "expiresAt", "idToken", "accountId"]);
    if (typeof value.refreshToken !== "string" || !Number.isFinite(value.expiresAt)) {
      throw new Error("auth-storage: core credentials require refreshToken and finite expiresAt");
    }
    if (!optionalString(value.idToken) || !optionalString(value.accountId)) {
      throw new Error("auth-storage: core credential optional fields must be strings");
    }
    return value;
  }
  if (namespace === "anthropic") {
    assertAllowedKeys(value, ["accessToken", "refreshToken", "expiresAt", "method", "provider"]);
    if (!optionalString(value.refreshToken) || !optionalNumber(value.expiresAt)) {
      throw new Error("auth-storage: anthropic refreshToken/expiresAt fields are invalid");
    }
    if (value.method !== undefined && value.method !== "oauth" && value.method !== "token") {
      throw new Error("auth-storage: anthropic method is invalid");
    }
    if (value.provider !== undefined && value.provider !== "anthropic") {
      throw new Error("auth-storage: anthropic provider marker is invalid");
    }
    const method = value.method ?? (value.refreshToken ? "oauth" : "token");
    return { ...value, provider: "anthropic", method };
  }
  assertAllowedKeys(value, [
    "accessToken", "refreshToken", "expiresAt", "authorizationEndpoint", "tokenEndpoint", "provider",
  ]);
  if (
    !optionalString(value.refreshToken) ||
    !optionalNumber(value.expiresAt) ||
    !optionalString(value.authorizationEndpoint) ||
    !optionalString(value.tokenEndpoint)
  ) {
    throw new Error("auth-storage: xai credential optional fields are invalid");
  }
  if (value.provider !== undefined && value.provider !== "xai") {
    throw new Error("auth-storage: xai provider marker is invalid");
  }
  return { ...value, provider: "xai" };
}

export interface CredentialWriteOptions {
  allowUnencryptedWrite?: boolean;
  warn?: (message: string) => void;
}

export function writeProviderCredentials(
  authPath: string,
  namespace: ProviderCredentialNamespace,
  credentials: unknown,
  options: CredentialWriteOptions = {},
): void {
  const validated = validateCredentials(namespace, credentials);
  const plaintext = JSON.stringify(validated, null, 2);
  let payload: string;
  try {
    payload = encryptAuthBlob(plaintext, dirname(authPath), namespace, authPath);
  } catch (e) {
    const reason = (e as Error).message;
    if (!options.allowUnencryptedWrite) {
      throw new Error(`auth-storage: refusing unencrypted credential write: ${reason}`, { cause: e });
    }
    const warning = `auth-storage: writing provider credentials unencrypted because degraded mode was explicitly enabled: ${reason}`;
    logger.warn(warning);
    options.warn?.(warning);
    payload = plaintext;
  }
  writeSecretFileAtomic(authPath, payload);
}

function resolveCredentialReadPath(authPath: string): string {
  const inherited = process.env.LAX_SELF_EDIT_PROBE === "1"
    ? process.env[PROBE_CREDENTIAL_PATH_ENV]
    : undefined;
  if (!inherited) return authPath;
  if (basename(inherited) !== basename(authPath)) {
    throw new Error(`auth-storage: inherited probe credential does not match ${basename(authPath)}`);
  }
  return inherited;
}

export function readProviderCredentials(
  authPath: string,
  namespace: ProviderCredentialNamespace,
): unknown | null {
  const readPath = resolveCredentialReadPath(authPath);
  if (!existsSync(readPath)) return null;
  const raw = readFileSync(readPath, "utf-8");
  const result = decryptAuthBlob(raw, dirname(readPath), namespace, readPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.plaintext);
  } catch (e) {
    throw new Error(`auth-storage: credential payload is not valid JSON: ${(e as Error).message}`);
  }
  const credentials = validateCredentials(namespace, parsed);
  if (result.format !== "v2" && readPath === authPath) {
    writeProviderCredentials(authPath, namespace, credentials);
    logger.info(`[auth-storage] Migrated ${authPath} to ${ENVELOPE_FORMAT}.`);
  }
  return credentials;
}
