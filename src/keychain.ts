import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { hostname, userInfo } from "node:os";

/**
 * OS Keychain Integration
 *
 * Stores the secrets encryption master key in the OS credential store
 * instead of deriving it from hostname+username. This means:
 *
 * - Windows: DPAPI (Data Protection API) — tied to your Windows login
 * - macOS: Keychain — tied to your macOS login
 * - Linux: libsecret (GNOME Keyring / KWallet) — tied to your desktop session
 * - Fallback: Machine-identity derivation (hostname+username+random salt)
 *
 * The master key is 32 bytes of random data, generated once and stored
 * in the OS keychain. Even if an attacker reads all files on disk,
 * they can't get the master key without your OS login credentials.
 *
 * Fallback chain:
 * 1. Try OS keychain (DPAPI/Keychain/libsecret)
 * 2. If unavailable, fall back to file-based key with machine-identity derivation
 * 3. Log which method is being used so the user knows
 */

const SERVICE_NAME = "SecretAgentX";
const ACCOUNT_NAME = "master-key";

export type KeychainProvider = "dpapi" | "macos-keychain" | "libsecret" | "file-fallback";

interface KeychainResult {
  key: Buffer;
  provider: KeychainProvider;
}

// ═══════════════════════════════════════════════════════════════════
// Windows DPAPI
// ═══════════════════════════════════════════════════════════════════

/** Store a key using Windows DPAPI (encrypted to current user's login) */
function dpapiStore(data: Buffer, filePath: string): void {
  // Use PowerShell to encrypt via DPAPI and write to file
  const b64 = data.toString("base64");
  const ps = `
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String('${b64}')
    $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllBytes('${filePath.replace(/\\/g, "\\\\")}', $encrypted)
  `;
  execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/\n/g, " ")}"`, {
    timeout: 10_000,
    stdio: "ignore",
  });
}

/** Retrieve a key using Windows DPAPI */
function dpapiRetrieve(filePath: string): Buffer {
  const ps = `
    Add-Type -AssemblyName System.Security
    $encrypted = [IO.File]::ReadAllBytes('${filePath.replace(/\\/g, "\\\\")}')
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Convert]::ToBase64String($decrypted)
  `;
  const result = execSync(
    `powershell -NoProfile -NonInteractive -Command "${ps.replace(/\n/g, " ")}"`,
    { encoding: "utf-8", timeout: 10_000 }
  ).trim();
  return Buffer.from(result, "base64");
}

/** Check if DPAPI is available (Windows only) */
function dpapiAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    execSync(
      'powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Security; echo ok"',
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    );
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// macOS Keychain
// ═══════════════════════════════════════════════════════════════════

function macKeychainStore(data: Buffer): void {
  const hex = data.toString("hex");
  try {
    // Delete existing entry first (ignore errors)
    execSync(
      `security delete-generic-password -s "${SERVICE_NAME}" -a "${ACCOUNT_NAME}" 2>/dev/null`,
      { stdio: "ignore" }
    );
  } catch { /* ok */ }
  execSync(
    `security add-generic-password -s "${SERVICE_NAME}" -a "${ACCOUNT_NAME}" -w "${hex}" -U`,
    { timeout: 5000 }
  );
}

function macKeychainRetrieve(): Buffer {
  const hex = execSync(
    `security find-generic-password -s "${SERVICE_NAME}" -a "${ACCOUNT_NAME}" -w`,
    { encoding: "utf-8", timeout: 5000 }
  ).trim();
  return Buffer.from(hex, "hex");
}

function macKeychainAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync("security help 2>&1", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Linux libsecret (GNOME Keyring / KWallet)
// ═══════════════════════════════════════════════════════════════════

function libsecretStore(data: Buffer): void {
  const hex = data.toString("hex");
  execSync(
    `secret-tool store --label="${SERVICE_NAME} Master Key" service "${SERVICE_NAME}" account "${ACCOUNT_NAME}"`,
    { input: hex, timeout: 5000 }
  );
}

function libsecretRetrieve(): Buffer {
  const hex = execSync(
    `secret-tool lookup service "${SERVICE_NAME}" account "${ACCOUNT_NAME}"`,
    { encoding: "utf-8", timeout: 5000 }
  ).trim();
  return Buffer.from(hex, "hex");
}

function libsecretAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execSync("which secret-tool", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// File-based fallback (machine-identity + random salt)
// ═══════════════════════════════════════════════════════════════════

function fileFallbackGetOrCreate(dataDir: string): Buffer {
  const saltPath = join(dataDir, "secrets.salt");
  let salt: Buffer;
  if (existsSync(saltPath)) {
    salt = readFileSync(saltPath);
  } else {
    salt = randomBytes(32);
    writeFileSync(saltPath, salt, { mode: 0o600 });
  }
  const identity = `sax-secrets::${hostname()}::${userInfo().username}`;
  // N=131072 (~500ms per attempt) — makes brute-force impractical even with known machine identity
  // WARNING: Changing these params invalidates existing encrypted secrets (users must re-enter keys)
  return scryptSync(identity, salt, 32, { N: 131072, r: 8, p: 2, maxmem: 256 * 1024 * 1024 });
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Get or create the master encryption key using the best available OS keychain.
 * Returns the 32-byte key and which provider was used.
 */
export function getOrCreateMasterKey(dataDir: string): KeychainResult {
  mkdirSync(dataDir, { recursive: true });
  const dpapiPath = join(dataDir, "master.dpapi");

  // ── Try DPAPI (Windows) ──
  if (dpapiAvailable()) {
    try {
      if (existsSync(dpapiPath)) {
        const key = dpapiRetrieve(dpapiPath);
        if (key.length === 32) {
          return { key, provider: "dpapi" };
        }
      }
      // Generate new key and protect with DPAPI
      const key = randomBytes(32);
      dpapiStore(key, dpapiPath);
      console.log("[keychain] Master key stored in Windows DPAPI");
      return { key, provider: "dpapi" };
    } catch (e) {
      console.warn(`[keychain] DPAPI failed: ${(e as Error).message}. Trying next provider.`);
    }
  }

  // ── Try macOS Keychain ──
  if (macKeychainAvailable()) {
    try {
      const key = macKeychainRetrieve();
      if (key.length === 32) {
        return { key, provider: "macos-keychain" };
      }
    } catch {
      // Key doesn't exist yet — create it
      try {
        const key = randomBytes(32);
        macKeychainStore(key);
        console.log("[keychain] Master key stored in macOS Keychain");
        return { key, provider: "macos-keychain" };
      } catch (e) {
        console.warn(`[keychain] macOS Keychain failed: ${(e as Error).message}. Trying next provider.`);
      }
    }
  }

  // ── Try libsecret (Linux) ──
  if (libsecretAvailable()) {
    try {
      const key = libsecretRetrieve();
      if (key.length === 32) {
        return { key, provider: "libsecret" };
      }
    } catch {
      try {
        const key = randomBytes(32);
        libsecretStore(key);
        console.log("[keychain] Master key stored in libsecret");
        return { key, provider: "libsecret" };
      } catch (e) {
        console.warn(`[keychain] libsecret failed: ${(e as Error).message}. Using file fallback.`);
      }
    }
  }

  // ── File-based fallback ──
  console.log("[keychain] Using file-based key derivation (OS keychain not available)");
  return { key: fileFallbackGetOrCreate(dataDir), provider: "file-fallback" };
}

/** Check which keychain provider is available on this system */
export function detectKeychainProvider(): KeychainProvider {
  if (dpapiAvailable()) return "dpapi";
  if (macKeychainAvailable()) return "macos-keychain";
  if (libsecretAvailable()) return "libsecret";
  return "file-fallback";
}
