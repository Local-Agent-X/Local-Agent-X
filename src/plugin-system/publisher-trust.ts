import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export type TrustLevel = "unsigned" | "hash-verified" | "signed";

export interface TrustedPublisher {
  name: string;
  publicKey?: string;
  publicKeys?: Record<string, string>;
}

export interface TrustedPublishersFile {
  [publisherId: string]: TrustedPublisher;
}

export type PublisherSignatureVerdict =
  | { status: "valid"; publisher: TrustedPublisher; keyId: string | null }
  | { status: "unknown-publisher" }
  | { status: "unknown-key"; publisher: TrustedPublisher }
  | { status: "invalid"; publisher: TrustedPublisher; keyId: string | null };

const TRUSTED_PUBLISHERS_PATH = join(getLaxDir(), "trusted-publishers.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function readTrustedPublishers(): TrustedPublishersFile {
  if (!existsSync(TRUSTED_PUBLISHERS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(TRUSTED_PUBLISHERS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function verifyEd25519(data: Buffer, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const signature = Buffer.from(signatureHex, "hex");
    const rawKey = Buffer.from(publicKeyHex, "hex");
    if (rawKey.length !== 32) return false;
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const keyObject = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    return cryptoVerify(null, data, keyObject, signature);
  } catch {
    return false;
  }
}

export function verifyPublisherSignature(
  publisherId: string,
  data: Buffer,
  signatureHex: string,
  keyId?: string,
): PublisherSignatureVerdict {
  const publisher = readTrustedPublishers()[publisherId];
  if (!publisher) return { status: "unknown-publisher" };

  let publicKey: string | undefined;
  let resolvedKeyId: string | null = null;
  if (keyId) {
    publicKey = publisher.publicKeys?.[keyId];
    resolvedKeyId = keyId;
    if (!publicKey) return { status: "unknown-key", publisher };
  } else if (publisher.publicKey) {
    publicKey = publisher.publicKey;
  } else {
    const keys = Object.entries(publisher.publicKeys ?? {});
    if (keys.length !== 1) return { status: "unknown-key", publisher };
    [resolvedKeyId, publicKey] = keys[0];
  }

  return verifyEd25519(data, signatureHex, publicKey)
    ? { status: "valid", publisher, keyId: resolvedKeyId }
    : { status: "invalid", publisher, keyId: resolvedKeyId };
}
