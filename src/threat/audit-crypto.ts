import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { computeAuditMarkerMac, getAuditHmacKey } from "../app-runtime/audit-signing.js";
import { createLogger } from "../logger.js";
import type { DataLabel } from "./classification.js";
import type { ThreatLevel } from "./scoring.js";

const logger = createLogger("threat.audit-trail");

// ═══════════════════════════════════════════════════════════════════
// CRYPTOGRAPHIC AUDIT TRAIL — Hash-chained tamper-evident log
// ═══════════════════════════════════════════════════════════════════
//
// Each entry is chained by an HMAC-SHA256 keyed digest over ALL of its
// security-relevant fields. The HMAC key is the per-install audit key
// (see audit-signing.ts). This means:
//   - Any change to a decision-bearing field (decision, reason, role,
//     threatScore, dataLabels, …) breaks the chain.
//   - An attacker with only filesystem access cannot recompute a valid
//     chain — a plain SHA-256 forgery will not match.
// Honest limit: an attacker who compromises the live kernel process can
// still read the key from memory, so this is tamper-evidence with
// authenticity, NOT non-repudiation against a process compromise.

export const GENESIS_PREV_HASH = "GENESIS";
export const GENESIS_ANCHOR_HASH = "ANCHOR-GENESIS";

// External anchor file: a second, independent keyed chain over the running
// chain-head. It exists to close the one gap the linear log can't see on its
// own — TAIL TRUNCATION. Dropping trailing entries leaves a perfectly valid
// shorter chain (the genesis-anchor check only catches re-rooting, not an
// end-cut), so an attacker who can append-then-rewind would erase their tracks
// silently. The anchor records (maxSeq, headHash, count); verify cross-checks
// it, so a truncated log no longer matches its anchor and fails.
//
// Honest limit: the anchor file lives in the same dir at the same privilege —
// a key-holding attacker who rewrites BOTH files consistently still defeats it.
// The real teeth come from the head being EMITTED to the app log (logger) each
// record, so an off-box log shipper holds a copy beyond the attacker's reach.
// This is rewrite-DETECTION groundwork, not rewrite-prevention.
export interface AnchorRecord {
  seq: number;        // chain head seq this anchor pins
  count: number;      // total entries at this point (seq + 1)
  chainHash: string;  // the main chain entry hash being anchored
  prevAnchor: string; // previous anchorHash (independent chain)
  anchorHash: string; // HMAC over the fields above
}

export interface AuditEntry {
  seq: number;
  timestamp: string;
  sessionId: string;
  event: string;
  toolName?: string;
  decision: "allow" | "block" | "warn";
  reason: string;
  role?: string;                    // RBAC role of the caller (operator/user/readonly)
  controlsApplied?: string[];       // Which security controls evaluated this (SecurityLayer, ToolPolicy, ThreatEngine, etc.)
  threatScore?: number;
  threatLevel?: ThreatLevel;
  dataLabels?: DataLabel[];
  hash: string;        // HMAC-SHA256 of this entry's canonical payload
  prevHash: string;    // Hash of previous entry (chain)
  /**
   * Hash scheme tag. "hmac-v1" marks entries written under the keyed,
   * full-field scheme. Absent on legacy plain-SHA-256 entries (which were
   * written before this upgrade and verify under the legacy path).
   */
  hashScheme?: "hmac-v1";
}

/**
 * Deterministic canonical serialization of the security-relevant fields that
 * must be inside the chain digest. Stable key order is required so that
 * verification reproduces exactly the bytes that were signed. Anything a
 * tamperer could alter to rewrite history belongs in here.
 */
function canonicalPayload(e: AuditEntry): string {
  return JSON.stringify([
    ["seq", e.seq],
    ["timestamp", e.timestamp],
    ["sessionId", e.sessionId],
    ["event", e.event],
    ["toolName", e.toolName ?? null],
    ["decision", e.decision],
    ["reason", e.reason],
    ["role", e.role ?? null],
    ["controlsApplied", e.controlsApplied ?? null],
    ["threatScore", e.threatScore ?? null],
    ["threatLevel", e.threatLevel ?? null],
    ["dataLabels", e.dataLabels ?? null],
    ["prevHash", e.prevHash],
    // Bind the scheme tag INTO the keyed digest so it can't be stripped or
    // swapped to downgrade an entry onto the unkeyed legacy verify path
    // without breaking the HMAC.
    ["hashScheme", e.hashScheme ?? null],
  ]);
}

/** Legacy payload — the original narrow field set, plain SHA-256. */
export function legacyPayload(e: AuditEntry): string {
  return JSON.stringify({
    seq: e.seq,
    timestamp: e.timestamp,
    sessionId: e.sessionId,
    event: e.event,
    toolName: e.toolName,
    decision: e.decision,
    reason: e.reason,
    prevHash: e.prevHash,
  });
}

function hmacKeyBuffer(): Buffer {
  const raw = getAuditHmacKey();
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

export function computeEntryHash(e: AuditEntry): string {
  return createHmac("sha256", hmacKeyBuffer()).update(canonicalPayload(e)).digest("hex");
}

/** Keyed MAC over an anchor's fields — the anchor file's own chain digest. */
export function computeAnchorHash(a: Omit<AnchorRecord, "anchorHash">): string {
  const payload = JSON.stringify([a.seq, a.count, a.chainHash, a.prevAnchor]);
  return createHmac("sha256", hmacKeyBuffer()).update(payload).digest("hex");
}

/** `<dir>/<date>.jsonl` → `<dir>/<date>.anchors.jsonl`. */
export function anchorPathFor(auditFilePath: string): string {
  return auditFilePath.replace(/\.jsonl$/, ".anchors.jsonl");
}

/** Today's daily-file date stamp (UTC, YYYY-MM-DD) — drives the file name and
 *  the midnight rollover check. */
export function currentAuditDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── hmac-v1 era marker ───────────────────────────────────────────────
// Once a single hmac-v1 entry has ever been written, the audit dir is in the
// "hmac-v1 era" and verify() MUST refuse to fall back to the unkeyed legacy
// path for ANY row — otherwise a filesystem-only attacker rewrites the whole
// file as self-consistent plain-SHA-256 (no key needed) and verify passes.
//
// The marker lives next to the audit data and is SEALED under the audit key: it
// stores a keyed MAC over a fixed string, so an attacker without the key can
// neither forge the marker nor delete-then-recreate it convincingly. Deleting
// the marker entirely doesn't help the attacker either — a chain that still
// contains hmac-v1 rows is verified as hmac-v1 regardless (see verify()).
const MARKER_PAYLOAD = "lax-audit-hmac-v1-era";

/** `<auditDir>/.hmac-v1.marker` — one per audit dir, not per day. */
export function markerPathFor(auditFilePath: string): string {
  return join(dirname(auditFilePath), ".hmac-v1.marker");
}

/** Write the era marker (idempotent) sealed under the audit key, mode 0o600. */
export function writeEraMarker(markerPath: string): void {
  if (existsSync(markerPath)) return;
  const body = JSON.stringify({ era: "hmac-v1", mac: computeAuditMarkerMac(MARKER_PAYLOAD) });
  // Atomic tmp+rename, mirroring writeAtomic() in audit-signing.ts.
  const tmp = `${markerPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, markerPath);
}

/**
 * Is the hmac-v1 era marker present for this audit dir? A present marker — even
 * one that's forged/corrupt — keeps the era active and the legacy fallback
 * off-limits: presence is the fail-closed signal, and a present-but-MAC-invalid
 * marker is itself tamper evidence (we validate the sealed MAC here, but a bad
 * MAC keeps the era ACTIVE — it does not re-open the legacy path). A *deleted*
 * marker no longer downgrades anything: key-presence (hasPersistedAuditKey) and
 * surviving hmac-v1 row tags drive the era decision in verify(), so this is now
 * just one of three independent era signals, not the load-bearing one.
 */
export function eraMarkerPresent(markerPath: string): boolean {
  if (existsSync(markerPath) === false) return false;
  // Validate the sealed MAC for tamper-evidence. A forged or corrupt marker
  // still returns true (present == era-active, fail-closed) — the MAC is what
  // stops an attacker RECREATING a *convincing* marker without the key, not a
  // switch that lets a present marker turn the era off. A MAC mismatch is real
  // tamper evidence, so surface it loudly rather than swallowing it.
  try {
    const body = JSON.parse(readFileSync(markerPath, "utf-8")) as { mac?: unknown };
    if (body.mac !== computeAuditMarkerMac(MARKER_PAYLOAD)) {
      logger.warn(`[audit] hmac-v1 era marker present but MAC invalid (forged/corrupt) — era stays active: ${markerPath}`);
    }
  } catch {
    logger.warn(`[audit] hmac-v1 era marker present but unreadable/corrupt — era stays active: ${markerPath}`);
  }
  return true;
}

/**
 * Verify the anchor chain and reconcile it with the main chain heads.
 *
 * A missing anchor file is only benign for a genuinely PRE-KEY / PRE-ANCHORING
 * log (no resolvable seed, no hmac-v1 rows, no era marker) — `anchoringInUse:
 * false` → `checked: false`, verified on the main chain alone with no
 * regression. Once anchoring is in use (`anchoringInUse: true` — caller passes
 * the key-presence-driven `eraActive`, so a resolvable seed alone is enough) an
 * absent anchor file alongside a non-empty audit file is TRUNCATION EVIDENCE —
 * the attacker who drops trailing main-chain lines also deletes the anchor that
 * would pin the true count — so it fails CLOSED rather than degrading to a
 * main-chain-only pass.
 *
 * When an anchor file IS present, every anchor must (a) carry a valid keyed MAC,
 * (b) link to its predecessor, and (c) match the main chain head at its seq —
 * and the anchor count must equal the number of main entries. A short main
 * chain against a longer anchor chain is exactly the tail-truncation this
 * exists to catch; the converse (anchor write lost to a crash) is reported
 * conservatively as broken rather than silently passed.
 */
export function verifyAnchors(
  anchorFile: string,
  heads: { seq: number; hash: string }[],
  anchoringInUse: boolean,
): { checked: boolean; broken: boolean; brokenAt?: number } {
  if (existsSync(anchorFile) === false) {
    // Anchoring in use but the anchor file is gone → truncation, fail closed.
    if (anchoringInUse) return { checked: true, broken: true, brokenAt: 0 };
    return { checked: false, broken: false };
  }
  let lines: string[];
  try {
    lines = readFileSync(anchorFile, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    return { checked: true, broken: true, brokenAt: 0 };
  }

  // Count mismatch = truncation on one side or the other.
  if (lines.length !== heads.length) {
    return { checked: true, broken: true, brokenAt: Math.min(lines.length, heads.length) };
  }

  let prevAnchor = GENESIS_ANCHOR_HASH;
  for (let i = 0; i < lines.length; i++) {
    let a: AnchorRecord;
    try {
      a = JSON.parse(lines[i]) as AnchorRecord;
    } catch {
      return { checked: true, broken: true, brokenAt: i };
    }
    const macOk = computeAnchorHash({ seq: a.seq, count: a.count, chainHash: a.chainHash, prevAnchor: a.prevAnchor }) === a.anchorHash;
    const linkOk = a.prevAnchor === prevAnchor;
    const matchesHead = a.seq === heads[i].seq && a.chainHash === heads[i].hash && a.count === i + 1;
    if (!macOk || !linkOk || !matchesHead) {
      return { checked: true, broken: true, brokenAt: i };
    }
    prevAnchor = a.anchorHash;
  }
  return { checked: true, broken: false };
}
