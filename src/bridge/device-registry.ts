// Paired-device registry for the mobile bridge.
//
// Persists one JSON file (devices.json) under the LAX data dir, alongside the
// existing tokens.json / config.json. Each paired phone gets a long-lived
// per-device bridge token; we store only a SHA-256 hash of that token (never
// the raw value — constitution §4/§5). A device can be revoked instantly,
// which both flips its status and lets the upgrade gate reject it.
//
// This is deliberately a focused, dependency-light module: no provider creds
// ever touch it (constitution §2). The raw token is returned exactly once at
// pairing time and never persisted.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";

const logger = createLogger("bridge.device-registry");

export type DeviceStatus = "active" | "revoked";

export interface DeviceRecord {
  id: string;
  label: string;
  /** SHA-256 hex of the raw bridge token. The raw token is never stored. */
  tokenHash: string;
  pairedAt: number;
  lastSeen: number;
  status: DeviceStatus;
}

/** Hash a bridge token the same way everywhere (matches rbac.ts hashToken). */
export function hashBridgeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function devicesPath(dataDir: string): string {
  return join(dataDir, "devices.json");
}

export class DeviceRegistry {
  private devices = new Map<string, DeviceRecord>();
  private readonly filePath: string;

  constructor(dataDir: string = getLaxDir()) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = devicesPath(dataDir);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as DeviceRecord[];
      for (const d of raw) this.devices.set(d.id, d);
    } catch {
      logger.warn(`[device-registry] corrupt ${this.filePath} — starting empty`);
    }
  }

  private save(): void {
    // Atomic write (tmp + rename) so a concurrent reader never sees a
    // half-written file — same posture as config.ts saveConfig.
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify([...this.devices.values()], null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
      throw e;
    }
  }

  /**
   * Register a freshly-paired device. The caller supplies the raw token (minted
   * elsewhere); we hash and persist. Returns the stored record (no raw token).
   */
  register(label: string, rawToken: string): DeviceRecord {
    const id = `dev-${randomBytes(6).toString("hex")}`;
    const now = Date.now();
    const record: DeviceRecord = {
      id,
      label: label.slice(0, 80) || "Unnamed device",
      tokenHash: hashBridgeToken(rawToken),
      pairedAt: now,
      lastSeen: now,
      status: "active",
    };
    this.devices.set(id, record);
    this.save();
    return record;
  }

  /**
   * Resolve a raw bridge token to an ACTIVE device, timing-safely. Returns the
   * record on a hit (and stamps lastSeen), or null for unknown/revoked tokens.
   * Revoked devices return null so the upgrade gate rejects them.
   */
  authenticate(rawToken: string): DeviceRecord | null {
    if (!rawToken) return null;
    const incoming = Buffer.from(hashBridgeToken(rawToken));
    for (const d of this.devices.values()) {
      const stored = Buffer.from(d.tokenHash);
      if (incoming.length === stored.length && timingSafeEqual(incoming, stored)) {
        if (d.status !== "active") return null;
        d.lastSeen = Date.now();
        this.save();
        return d;
      }
    }
    return null;
  }

  /** Flip a device to revoked. Returns true if it existed and was active. */
  revoke(id: string): boolean {
    const d = this.devices.get(id);
    if (!d || d.status === "revoked") return false;
    d.status = "revoked";
    this.save();
    logger.info(`[device-registry] revoked device ${id} (${d.label})`);
    return true;
  }

  get(id: string): DeviceRecord | undefined {
    return this.devices.get(id);
  }

  /** List devices without exposing token hashes. */
  list(): Array<Omit<DeviceRecord, "tokenHash">> {
    return [...this.devices.values()].map(({ tokenHash: _drop, ...rest }) => rest);
  }
}

// Process-wide singleton so the upgrade gate, the pairing route, and the
// revocation entry point all share one in-memory registry (and one save lock).
let _registry: DeviceRegistry | null = null;
export function getDeviceRegistry(): DeviceRegistry {
  if (!_registry) _registry = new DeviceRegistry();
  return _registry;
}

/** Test seam — reset the singleton so a test can point at a temp data dir. */
export function setDeviceRegistryForTest(reg: DeviceRegistry | null): void {
  _registry = reg;
}
