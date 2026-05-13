import { createHash } from "node:crypto";

import type { DataClassification } from "./classification.js";

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

  /** Record a tool call and check for dangerous patterns */
  recordAndAnalyze(
    toolName: string,
    args: Record<string, unknown>,
    resultClassification: DataClassification
  ): { blocked: boolean; reason?: string; exfil?: ExfilPattern; loopDetected?: string; allowedByConsent?: string } {
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

    // Exfiltration detection: did we read something sensitive, then try to send it out?
    if (access && this.isExternalSink(access)) {
      const exfil = this.checkExfiltration(access);
      if (exfil) {
        // User-consent bypass. If the user message that started this turn
        // had attachments + directive language, the entrypoint marked
        // consent active. The exfil pattern still gets *audited* (audit
        // record is the responsibility of threat-engine.ts), but not
        // blocked. The block path silently allowing is intentional — the
        // audit trail preserves security state.
        if (this.isUserConsentActive()) {
          return { blocked: false, allowedByConsent: this.userConsentReason || "user-consent-active", exfil };
        }
        return { blocked: true, reason: exfil.description, exfil };
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

  /** Check if a file path is inherently sensitive (regardless of content) */
  private isPathSensitive(filePath: string): boolean {
    const p = filePath.toLowerCase().replace(/\\/g, "/");
    const sensitivePatterns = [
      /\.ssh\//,  /\.aws\//, /\.gnupg\//, /\.kube\//, /\.env$/,
      /\.env\./, /id_rsa/, /id_ed25519/, /credentials/, /\.netrc/,
      /\.npmrc/, /\.pypirc/, /auth\.json/, /secrets?\./, /password/,
      /\.git\/config/, /config\.json$/, /token/, /\.lax\//,
      /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
      // Any file outside workspace is potentially sensitive
    ];
    return sensitivePatterns.some(pat => pat.test(p));
  }

  /** Check if a shell command accesses sensitive resources */
  private isCommandSensitive(command: string): boolean {
    const c = command.toLowerCase();
    return /\b(cat|type|more|less|head|tail|get-content)\b/.test(c) &&
      (this.isPathSensitive(c) || /\/etc\//.test(c) || /registry/.test(c));
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
        const sensitive = contentSensitive || this.isPathSensitive(path);
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

  private checkExfiltration(sink: DataAccess): ExfilPattern | null {
    // Look back through recent history for sensitive reads
    // 15-minute window to catch delayed exfil attempts
    const lookback = 900_000; // 15 minutes
    const now = Date.now();

    for (const source of this.history) {
      if (!source.sensitive) continue;
      if (now - source.timestamp > lookback) continue;
      if (source === sink) continue;

      // Sensitive source → external sink = exfiltration
      if (["file_read", "shell", "memory", "secret"].includes(source.type)) {
        return {
          source,
          sink,
          score: 0.9,
          description:
            `Exfiltration pattern detected: sensitive ${source.type} (${source.target.slice(0, 50)}) ` +
            `followed by external ${sink.type} (${sink.target.slice(0, 50)}). ` +
            `This looks like an attempt to send sensitive data to an external service.`,
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
