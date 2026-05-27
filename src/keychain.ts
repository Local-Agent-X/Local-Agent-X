import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { hostname, userInfo } from "node:os";

import { createLogger } from "./logger.js";
const logger = createLogger("keychain");

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

const SERVICE_NAME = "lax";
const ACCOUNT_NAME = "master-key";

// All child processes on Windows use CREATE_NO_WINDOW via execFileSync + windowsHide
const HIDDEN = { windowsHide: true } as const;

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
  const b64 = data.toString("base64");
  // Unique script suffix per call. Multiple SecretsStore instances run
  // concurrently on boot (server + self-edit tool + workers + mcp-client);
  // a fixed shared script/output path lets one process's cleanup unlink
  // another's file mid-flight, which surfaced as ENOENT master.dpapi.b64
  // crashes in 2026-05-09 logs.
  const scriptPath = filePath + "." + randomBytes(6).toString("hex") + ".ps1";
  const script =
    `Add-Type -AssemblyName System.Security\n` +
    `$bytes = [Convert]::FromBase64String('${b64}')\n` +
    `$encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n` +
    `[IO.File]::WriteAllBytes('${filePath.replace(/\\/g, "/")}', $encrypted)\n`;
  writeFileSync(scriptPath, script, "utf-8");
  try {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-ExecutionPolicy", "Bypass", "-File", scriptPath
    ], { timeout: 10_000, stdio: "ignore", ...HIDDEN });
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

/** Retrieve a key using Windows DPAPI */
function dpapiRetrieve(filePath: string): Buffer {
  // Unique paths per call — see dpapiStore comment. Without this,
  // concurrent SecretsStore boots race on the shared `.retrieve.ps1`
  // + `.b64` filenames; one process's `unlinkSync(outPath)` deletes
  // another's output before its `readFileSync` runs.
  const suffix = randomBytes(6).toString("hex");
  const scriptPath = filePath + "." + suffix + ".retrieve.ps1";
  const outPath = filePath + "." + suffix + ".b64";
  // $ErrorActionPreference=Stop so a silent Unprotect failure exits
  // non-zero (so execFileSync throws) instead of writing an empty .b64
  // that we later parse as 0 bytes of "key material".
  const script =
    `$ErrorActionPreference = 'Stop'\n` +
    `Add-Type -AssemblyName System.Security\n` +
    `$encrypted = [IO.File]::ReadAllBytes('${filePath.replace(/\\/g, "/")}')\n` +
    `$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n` +
    `[IO.File]::WriteAllText('${outPath.replace(/\\/g, "/")}', [Convert]::ToBase64String($decrypted))\n`;
  writeFileSync(scriptPath, script, "utf-8");
  try {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-ExecutionPolicy", "Bypass", "-File", scriptPath
    ], { timeout: 10_000, stdio: "ignore", ...HIDDEN });
    const result = readFileSync(outPath, "utf-8").trim();
    return Buffer.from(result, "base64");
  } finally {
    try { unlinkSync(scriptPath); } catch {}
    try { unlinkSync(outPath); } catch {}
  }
}

/** Check if DPAPI is available (Windows only) */
function dpapiAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", "Add-Type -AssemblyName System.Security; echo ok"
    ], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], ...HIDDEN });
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
  // `-U` already updates the existing entry idempotently. A preceding
  // explicit delete adds a race window (process A deletes, process B
  // adds, process A adds-and-clobbers) for zero benefit when multiple
  // SecretsStore instances race on first boot.
  //
  // `-T /usr/bin/security` puts the security CLI on the entry's ACL
  // trust list. Without this, macOS keys ACL trust on the *creating
  // process's code signing identity* — so an in-place upgrade from
  // unsigned-dev to a Developer-ID-signed build (different signature)
  // re-prompts the user with "Allow / Always Allow / Deny" on the
  // first find-generic-password call. We always shell out via
  // /usr/bin/security, so trusting just the CLI is narrower than `-A`
  // (which would grant any app on the system) while still surviving
  // signature changes on app upgrade.
  execFileSync("security", [
    "add-generic-password",
    "-s", SERVICE_NAME, "-a", ACCOUNT_NAME, "-w", hex,
    "-T", "/usr/bin/security",
    "-U"
  ], { timeout: 5000 });
}

function macKeychainRetrieve(): Buffer {
  const hex = execFileSync("security", [
    "find-generic-password", "-s", SERVICE_NAME, "-a", ACCOUNT_NAME, "-w"
  ], { encoding: "utf-8", timeout: 5000 }).trim();
  return Buffer.from(hex, "hex");
}

function macKeychainAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    // Resolve the default user keychain. If macOS can't find one — no
    // default set, default pointing to a deleted file, sandboxed parent
    // process whose audit session lacks visibility into the user's
    // login keychain — a subsequent add/find-generic-password call
    // triggers the modal "Keychain Not Found / Reset To Defaults" GUI
    // dialog, blocking the boot until the user dismisses it. Pre-empt
    // that by detecting an unusable default here and falling through
    // to the file fallback silently.
    const out = execFileSync("security", ["default-keychain", "-d", "user"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const path = out.trim().replace(/^"|"$/g, "");
    if (!path || !existsSync(path)) return false;
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
  execFileSync("secret-tool", [
    "store", `--label=${SERVICE_NAME} Master Key`,
    "service", SERVICE_NAME, "account", ACCOUNT_NAME
  ], { input: hex, timeout: 5000 });
}

function libsecretRetrieve(): Buffer {
  const hex = execFileSync("secret-tool", [
    "lookup", "service", SERVICE_NAME, "account", ACCOUNT_NAME
  ], { encoding: "utf-8", timeout: 5000 }).trim();
  return Buffer.from(hex, "hex");
}

function libsecretAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("which", ["secret-tool"], { stdio: "ignore", timeout: 3000 });
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
  // Renamed from "sax-secrets" to "lax-secrets" in the SAX→LAX rebrand.
  // Anyone using the file-fallback path (no DPAPI/Keychain/libsecret available)
  // and upgrading from a pre-rebrand build will need to re-import secrets —
  // their existing secrets.enc was encrypted with the old identity and won't
  // decrypt with the new one. DPAPI / macOS Keychain / libsecret users are
  // unaffected (their key is in the OS keychain, not derived from this).
  const identity = `lax-secrets::${hostname()}::${userInfo().username}`;
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
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dpapiPath = join(dataDir, "master.dpapi");
  const secretsPath = join(dataDir, "secrets.enc");

  // Escape hatch: skip every OS keychain provider and go straight to the
  // file fallback. Use when the OS keychain GUI ("Keychain Not Found",
  // ACL prompts) keeps interrupting the user — common when many SecretsStore
  // instances boot in parallel (server + workers + mcp-client) and race on
  // `security` CLI calls. Only safe to flip ON for an install that has no
  // existing secrets.enc, or one that was created under file-fallback to
  // begin with; flipping it ON for a keychain-backed install will orphan
  // every secret in secrets.enc.
  if (process.env.LAX_DISABLE_OS_KEYCHAIN === "1") {
    logger.info("[keychain] LAX_DISABLE_OS_KEYCHAIN=1 — skipping OS keychain providers");
    return { key: fileFallbackGetOrCreate(dataDir), provider: "file-fallback" };
  }

  // Critical safety rule: an EXISTING master key file is load-only. We
  // never auto-rotate on retrieve failure — the previous behavior
  // silently regenerated the key on transient PowerShell / DPAPI / OS
  // glitches, which then made `secrets.enc` (encrypted with the old
  // key) permanently unrecoverable. Real incident: 2026-05-09, lost a
  // user's TELEGRAM_BOT_TOKEN + other API keys to this race when a
  // worker subprocess hit a transient retrieve hiccup and rotated
  // master.dpapi, invalidating the main server's secrets.enc on the
  // next reload. Fix: split "first-run" (file does NOT exist; safe to
  // generate) from "existing key" (must succeed or throw — caller
  // surfaces the error and the user investigates rather than the
  // store silently nuking their data).
  const refuseRotateMessage = (provider: string, why: string) =>
    `Cannot retrieve ${provider}-protected master key — ${why}\n` +
    `Refusing to auto-regenerate; that would silently invalidate every secret in ${secretsPath}.\n` +
    `If you've intentionally rotated credentials, delete ${dpapiPath} AND ${secretsPath} together to start fresh, then re-add your secrets.`;

  // ── Try DPAPI (Windows) ──
  if (dpapiAvailable()) {
    if (existsSync(dpapiPath)) {
      // Existing key — must load successfully. Don't fall through.
      try {
        const key = dpapiRetrieve(dpapiPath);
        if (key.length === 32) {
          return { key, provider: "dpapi" };
        }
        throw new Error(`DPAPI returned ${key.length} bytes (expected 32) — file likely corrupt`);
      } catch (e) {
        throw new Error(refuseRotateMessage("DPAPI", (e as Error).message));
      }
    }
    // First-run — no master.dpapi yet. Safe to generate.
    try {
      const key = randomBytes(32);
      dpapiStore(key, dpapiPath);
      logger.info("[keychain] Master key stored in Windows DPAPI");
      return { key, provider: "dpapi" };
    } catch (e) {
      logger.warn(`[keychain] DPAPI store failed: ${(e as Error).message}. Trying next provider.`);
    }
  }

  // ── Try macOS Keychain ──
  if (macKeychainAvailable()) {
    // Try retrieve first. If a key exists in Keychain and retrieve
    // succeeds, return it; if retrieve fails, throw (don't rotate).
    // Only generate if Keychain has no key for our service yet.
    try {
      const key = macKeychainRetrieve();
      if (key.length === 32) {
        return { key, provider: "macos-keychain" };
      }
      throw new Error(`Keychain returned ${key.length} bytes (expected 32) — entry corrupt`);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Distinguish "no entry" (safe to generate) from "retrieve broke"
      // (must throw). Keychain `security find-generic-password` exits
      // with code 44 / "could not be found" when the entry is absent.
      const isMissing = /could not be found|44|SecKeychainSearchCopyNext|errSecItemNotFound/i.test(msg);
      if (!isMissing && existsSync(secretsPath)) {
        // We have an encrypted secrets file but can't get the key — fail loud.
        throw new Error(refuseRotateMessage("macOS Keychain", msg));
      }
      // Either no key entry yet, or no secrets file to lose — safe to init.
      try {
        const key = randomBytes(32);
        macKeychainStore(key);
        logger.info("[keychain] Master key stored in macOS Keychain");
        return { key, provider: "macos-keychain" };
      } catch (e2) {
        logger.warn(`[keychain] macOS Keychain failed: ${(e2 as Error).message}. Trying next provider.`);
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
      throw new Error(`libsecret returned ${key.length} bytes (expected 32) — entry corrupt`);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const isMissing = /no such secret|item not found|no results/i.test(msg);
      if (!isMissing && existsSync(secretsPath)) {
        throw new Error(refuseRotateMessage("libsecret", msg));
      }
      try {
        const key = randomBytes(32);
        libsecretStore(key);
        logger.info("[keychain] Master key stored in libsecret");
        return { key, provider: "libsecret" };
      } catch (e2) {
        logger.warn(`[keychain] libsecret failed: ${(e2 as Error).message}. Using file fallback.`);
      }
    }
  }

  // ── File-based fallback ──
  logger.info("[keychain] Using file-based key derivation (OS keychain not available)");
  return { key: fileFallbackGetOrCreate(dataDir), provider: "file-fallback" };
}

/** Check which keychain provider is available on this system */
export function detectKeychainProvider(): KeychainProvider {
  if (process.env.LAX_DISABLE_OS_KEYCHAIN === "1") return "file-fallback";
  if (dpapiAvailable()) return "dpapi";
  if (macKeychainAvailable()) return "macos-keychain";
  if (libsecretAvailable()) return "libsecret";
  return "file-fallback";
}
