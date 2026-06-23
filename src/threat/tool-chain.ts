import { createHash } from "node:crypto";

import type { DataClassification } from "./classification.js";
import { fingerprintOf, isLearned } from "./trust-ledger.js";
import { isSensitivePath, extractSensitivePathsFromCommand, detectSecretsInOutput } from "../data-lineage-paths.js";

// ═══════════════════════════════════════════════════════════════════
// TOOL CHAIN ANALYSIS — Track tool sequences, block exfiltration
// ═══════════════════════════════════════════════════════════════════

/** What data a tool call touched */
interface DataAccess {
  type: "file_read" | "file_write" | "shell" | "web_fetch" | "http_request" | "browser" | "memory" | "secret";
  target: string;       // file path, URL, command, etc.
  sensitive: boolean;    // classified as sensitive by data classifier
  timestamp: number;
}

/** Exfiltration pattern: sensitive data read followed by external send */
export interface ExfilPattern {
  source: DataAccess;
  sink: DataAccess;
  score: number;
  description: string;
}

// Tool call hashing for loop detection
function hashToolCall(name: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${name}:${JSON.stringify(args)}`).digest("hex").slice(0, 16);
}

// The bytes an external sink would put on the wire: URL + body + header values.
// Scanned for secret-shaped spans so the exfil check is data-flow (what leaves)
// rather than temporal (what was read). Mirrors the egress guard's pre-scan set
// (http-egress-guard.ts), plus the URL so a secret in a GET query param is seen.
function outboundPayload(args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (args.url) parts.push(String(args.url));
  if (args.body) parts.push(String(args.body));
  if (args.headers && typeof args.headers === "object") {
    for (const v of Object.values(args.headers as Record<string, unknown>)) parts.push(String(v));
  }
  return parts.join("\n");
}

export class ToolChainAnalyzer {
  private history: DataAccess[] = [];
  private callHashes: string[] = [];
  private readonly MAX_HISTORY = 100;
  // User-consented flow window. When the user attaches files in chat AND
  // gives directive language ("enter this in X", "submit to X", etc.),
  // the chat-turn entrypoint marks consent active for the next 30 min.
  // While active, exfil patterns whose source originated during the
  // consent window are AUDITED but not blocked — the user said this is
  // the work. Without the window, every chat-attach-and-send workflow
  // hits the exfil block (live failure 2026-05-13: invoice PDF → Thrivemetrics).
  private userConsentActiveUntil = 0;
  private userConsentReason = "";
  // Last fingerprint we blocked, so the /approve handler can find it
  // and record into the trust ledger. Per-turn (per ThreatEngine instance).
  // Layer B carries the fingerprint across turns via session-bridge.
  private lastBlockedFingerprint: string | null = null;

  /** Record a tool call and check for dangerous patterns */
  recordAndAnalyze(
    toolName: string,
    args: Record<string, unknown>,
    resultClassification: DataClassification
  ): {
    blocked: boolean;
    reason?: string;
    exfil?: ExfilPattern;
    /** Non-blocking temporal signal: a sensitive read preceded this external
     *  call but nothing secret was on the wire. The caller scores it (so
     *  repeated staging escalates) without blocking the call. */
    staging?: ExfilPattern;
    loopDetected?: string;
    allowedByConsent?: string;
    /** Fingerprint of the blocked pattern, when blocked. Layer B reads
     *  this so /approve can record into the trust ledger. */
    blockedFingerprint?: string;
  } {
    const access = this.classifyAccess(toolName, args, resultClassification);
    if (access) {
      this.history.push(access);
      if (this.history.length > this.MAX_HISTORY) this.history.shift();
    }

    // Loop detection
    const hash = hashToolCall(toolName, args);
    this.callHashes.push(hash);
    const loopResult = this.detectLoops(hash);
    if (loopResult) {
      return { blocked: true, reason: loopResult, loopDetected: loopResult };
    }

    // Encoding detection: flag base64/hex encoding as a data transform (exfil prep)
    if (access && access.type === "shell") {
      const cmd = String(args.command || "").toLowerCase();
      const ENCODING_PATTERNS = /\bbase64\b|\bxxd\b|\bod\s+-[xA]|\bopenssl\s+enc\b|\bhex\b.*encode|\bencode.*\bhex\b|\bprintf\s+'%x/i;
      if (ENCODING_PATTERNS.test(cmd)) {
        // Mark this as a sensitive data transform — inherits taint from any prior sensitive read
        const hasPriorSensitive = this.history.some(h => h.sensitive && Date.now() - h.timestamp < 120_000);
        if (hasPriorSensitive) {
          return {
            blocked: true,
            reason: `Exfiltration prep detected: encoding command (${cmd.slice(0, 60)}) after sensitive data access. ` +
              `Data encoding after reading sensitive files is a known exfiltration technique.`,
          };
        }
      }
    }

    // Exfiltration detection: is secret material actually in the outbound payload?
    if (access && this.isExternalSink(access)) {
      const exfil = this.checkExfiltration(access, args);
      if (exfil) {
        const fp = fingerprintOf(exfil.source.type, exfil.sink.target);
        // Layer C: trust ledger. If the user has approved this exact
        // pattern (sourceType:sinkHostname) before via /approve, allow
        // without prompting. Persistent across server restarts.
        if (fp && isLearned(fp)) {
          return { blocked: false, allowedByConsent: `learned-pattern:${fp}`, exfil };
        }
        // Layer A: per-turn consent (chat attachments + directive verbs).
        if (this.isUserConsentActive()) {
          return { blocked: false, allowedByConsent: this.userConsentReason || "user-consent-active", exfil };
        }
        // Stash the fingerprint so the /approve handler can find it and
        // record into the trust ledger for future auto-allows.
        if (fp) this.lastBlockedFingerprint = fp;
        return { blocked: true, reason: exfil.description, exfil, blockedFingerprint: fp ?? undefined };
      }

      // No secret on the wire, but a sensitive read preceded this external
      // call: a staging SIGNAL, not a block. Scored by the caller so persistent
      // read-then-send escalates the session, without trapping the legitimate
      // configure-then-test / read-then-submit workflows that the temporal-only
      // block used to hard-fail. Consent (or a learned pattern) suppresses even
      // the signal — the user directed this flow.
      const staging = this.checkTemporalStaging(access);
      if (staging) {
        if (this.isUserConsentActive()) {
          return { blocked: false, allowedByConsent: this.userConsentReason || "user-consent-active", staging };
        }
        return { blocked: false, staging };
      }
    }

    return { blocked: false };
  }

  /** Mark the next `durationMs` window as user-consented. The chat entrypoint
   *  calls this when the user explicitly directs an attached-file flow. */
  markUserConsent(durationMs: number, reason: string): void {
    this.userConsentActiveUntil = Date.now() + durationMs;
    this.userConsentReason = reason;
  }

  /** True when the current moment is inside an active user-consent window. */
  isUserConsentActive(): boolean {
    return Date.now() < this.userConsentActiveUntil;
  }

  /** Fingerprint of the most recent block this analyzer issued, if any.
   *  Layer B uses this to record into the trust ledger when the user
   *  types /approve. */
  getLastBlockedFingerprint(): string | null {
    return this.lastBlockedFingerprint;
  }

  /** Check if a shell command accesses sensitive resources */
  private isCommandSensitive(command: string): boolean {
    const c = command.toLowerCase();
    return /\b(cat|type|more|less|head|tail|get-content)\b/.test(c) &&
      (extractSensitivePathsFromCommand(command).length > 0 || /\/etc\//.test(c) || /registry/.test(c));
  }

  private classifyAccess(
    toolName: string,
    args: Record<string, unknown>,
    classification: DataClassification
  ): DataAccess | null {
    // Sensitive by CONTENT (regex classification) OR by SOURCE PATH
    const contentSensitive = classification.labels.length > 0;
    switch (toolName) {
      case "read": {
        const path = String(args.path || "");
        const sensitive = contentSensitive || isSensitivePath(path);
        return { type: "file_read", target: path, sensitive, timestamp: Date.now() };
      }
      case "write":
      case "edit":
        return { type: "file_write", target: String(args.path || ""), sensitive: contentSensitive, timestamp: Date.now() };
      case "bash": {
        const cmd = String(args.command || "");
        const sensitive = contentSensitive || this.isCommandSensitive(cmd);
        return { type: "shell", target: cmd, sensitive, timestamp: Date.now() };
      }
      case "web_fetch":
        return { type: "web_fetch", target: String(args.url || ""), sensitive: contentSensitive, timestamp: Date.now() };
      case "http_request":
        return { type: "http_request", target: String(args.url || ""), sensitive: contentSensitive, timestamp: Date.now() };
      case "browser":
        return { type: "browser", target: String(args.url || args.action || ""), sensitive: contentSensitive, timestamp: Date.now() };
      case "memory_search":
      case "memory_get":
        return { type: "memory", target: String(args.query || args.path || ""), sensitive: true, timestamp: Date.now() }; // Memory is always sensitive
      case "request_secret":
        return { type: "secret", target: String(args.name || ""), sensitive: true, timestamp: Date.now() };
      default:
        return null;
    }
  }

  private isExternalSink(access: DataAccess): boolean {
    return ["web_fetch", "http_request", "browser"].includes(access.type);
  }

  private checkExfiltration(sink: DataAccess, args: Record<string, unknown>): ExfilPattern | null {
    // Data-flow, not temporal. An external send is exfiltration only when the
    // OUTBOUND PAYLOAD actually carries secret material — a prior sensitive read
    // that never reaches the wire is normal credential/config use, not exfil
    // (live failure 2026-06-23: reading a connector manifest then calling its
    // own proxy tripped the old read-then-send correlation). {{SECRET_NAME}}
    // placeholders are not secret-shaped, so injecting a stored key into its own
    // API passes cleanly; a hardcoded raw key does not. Exact-byte exfil of a
    // non-secret-shaped value is still covered by the data-lineage taint gate.
    const payload = outboundPayload(args);
    if (!payload) return null;
    const { matched, kinds } = detectSecretsInOutput(payload);
    if (!matched) return null;

    // Attribute to the most recent in-window sensitive read for the audit
    // description + trust-ledger fingerprint; fall back to the sink itself.
    const now = Date.now();
    const source = [...this.history].reverse().find(
      s => s.sensitive && s !== sink && now - s.timestamp <= 900_000 &&
        ["file_read", "shell", "memory", "secret"].includes(s.type),
    ) ?? sink;
    return {
      source,
      sink,
      score: 0.9,
      description:
        `Exfiltration pattern detected: outbound ${sink.type} to ${sink.target.slice(0, 50)} ` +
        `carries secret-shaped content (${kinds.join(", ")}). ` +
        `This looks like an attempt to send sensitive data to an external service.`,
    };
  }

  /** Temporal staging signal: a sensitive read within the window preceded this
   *  external sink, but no secret reached the wire. Not a block — a behavioral
   *  score the caller accumulates so persistent read-then-send still escalates. */
  private checkTemporalStaging(sink: DataAccess): ExfilPattern | null {
    const lookback = 900_000; // 15 minutes
    const now = Date.now();
    for (const source of this.history) {
      if (!source.sensitive) continue;
      if (now - source.timestamp > lookback) continue;
      if (source === sink) continue;
      if (["file_read", "shell", "memory", "secret"].includes(source.type)) {
        return {
          source,
          sink,
          score: 0.5,
          description:
            `Suspected staging: sensitive ${source.type} (${source.target.slice(0, 50)}) ` +
            `preceded external ${sink.type} (${sink.target.slice(0, 50)}) — no secret was in the payload, ` +
            `so this is scored as a behavioral signal, not blocked.`,
        };
      }
    }
    return null;
  }

  /** Detect tool call loops (generic repeat + ping-pong + multi-pattern) */
  private detectLoops(currentHash: string): string | null {
    const recent = this.callHashes.slice(-30);

    // Generic repeat: same exact call 12+ times consecutively
    let repeatCount = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i] === currentHash) repeatCount++;
      else break;
    }
    if (repeatCount >= 12) {
      return `Tool loop detected: same call repeated ${repeatCount} times. Agent may be stuck.`;
    }

    // Ping-pong: A-B-A-B pattern (4+ alternations = 8 calls)
    if (recent.length >= 8) {
      const last8 = recent.slice(-8);
      let pingPong = true;
      for (let i = 0; i < last8.length; i++) {
        if (last8[i] !== last8[i % 2]) {
          pingPong = false;
          break;
        }
      }
      if (pingPong && last8[0] !== last8[1]) {
        return "Ping-pong loop detected: two tool calls alternating repeatedly.";
      }
    }

    // Triple-pattern loop: A-B-C-A-B-C (3+ cycles = 9 calls)
    if (recent.length >= 9) {
      const last9 = recent.slice(-9);
      let tripleLoop = true;
      for (let i = 3; i < last9.length; i++) {
        if (last9[i] !== last9[i % 3]) {
          tripleLoop = false;
          break;
        }
      }
      if (tripleLoop && last9[0] !== last9[1] && last9[1] !== last9[2]) {
        return "Triple-pattern loop detected: three tool calls cycling repeatedly.";
      }
    }

    // Global circuit breaker: 40+ tool calls with low diversity
    if (this.callHashes.length >= 40) {
      const uniqueRecent = new Set(this.callHashes.slice(-40));
      if (uniqueRecent.size <= 5) {
        return `Circuit breaker: ${this.callHashes.length}+ calls with only ${uniqueRecent.size} unique patterns. Agent is stuck.`;
      }
    }

    return null;
  }

  reset(): void {
    this.history = [];
    this.callHashes = [];
  }
}
