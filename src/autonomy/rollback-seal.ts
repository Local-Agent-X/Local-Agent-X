/**
 * Sealed rollback backups — the copy the rollback store keeps of a credential
 * file, encrypted at rest and short-lived.
 *
 * Every file a call may change is copied aside before the call (rollback.ts)
 * so the change can be undone. For a credential file that copy IS the secret:
 * on 2026-11-08 the agent deleted a downloaded service-account key and its
 * private key sat in plaintext under ~/.lax/rollback/ until someone found it.
 * Peter's ruling: a delete the user asked for by name leaves nothing behind
 * (rollback.ts keeps a `final` artifact, no bytes); a change the agent made on
 * its own stays undoable, but the copy is sealed and swept soon after.
 *
 * The seal is AES-256-GCM under the same master key that protects the secrets
 * vault (keychain.ts: DPAPI on Windows, the Keychain on macOS, libsecret or
 * the file fallback elsewhere), so a copy of the rollback folder is ciphertext
 * without the user's OS account. The tool call id is the AAD: a sealed blob
 * opens only as the backup of the call that made it. After SEALED_TTL_MS the
 * backup is swept (rollback.ts pruneRollbacks) and a restore refuses it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getLaxDir } from "../lax-data-dir.js";
import { getOrCreateMasterKey } from "../keychain.js";

/** How long a sealed backup can be undone. */
export const SEALED_TTL_MS = 24 * 3_600_000;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD_PREFIX = "lax-rollback-v1:";

let masterKey: Buffer | null = null;

/** The vault's master key, fetched from the OS keychain once per process. */
function key(): Buffer {
  if (!masterKey) masterKey = getOrCreateMasterKey(getLaxDir()).key;
  return masterKey;
}

/** Copy `src` to `dest` sealed for `toolCallId`: nonce, then ciphertext with the tag appended. */
export function sealBackup(src: string, dest: string, toolCallId: string): void {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(AAD_PREFIX + toolCallId, "utf8"));
  const plain = readFileSync(src);
  const sealed = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  plain.fill(0);
  writeFileSync(dest, sealed);
}

/** The bytes a sealed backup holds. Throws when the blob was not sealed for this call or was altered. */
export function openBackup(dest: string, toolCallId: string): Buffer {
  const sealed = readFileSync(dest);
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error(`sealed backup too short: ${dest}`);
  const decipher = createDecipheriv("aes-256-gcm", key(), sealed.subarray(0, NONCE_BYTES));
  decipher.setAAD(Buffer.from(AAD_PREFIX + toolCallId, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
}

/** Test seam: forget the cached key so the next call reads it again. */
export function _resetSealKeyForTest(): void {
  masterKey = null;
}
