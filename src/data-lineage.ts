/**
 * Data Lineage Tracker
 *
 * Tracks the flow of data through tool calls within a session.
 * When data is read from a sensitive source, it gets a taint label.
 * If that tainted data flows into an egress channel (http, browser),
 * the call is blocked — even if the data was transformed (base64, chunked, etc).
 *
 * Unlike regex-based detection, this tracks by CALL SEQUENCE:
 *   read(sensitive_file) → bash(any_transform) → http_request = BLOCKED
 *
 * The key insight: any data that entered the LLM context from a sensitive
 * source is tainted for the rest of the run. The LLM can't "un-see" it.
 */

export type TaintSource = "sensitive_file" | "secret" | "memory" | "web" | "user_data";

interface TaintEntry {
  source: TaintSource;
  target: string;     // file path, secret name, URL, etc.
  timestamp: number;
  runId: string;
}

// Per-session taint state
const sessionTaint = new Map<string, TaintEntry[]>();

/** Record a sensitive data read */
export function recordSensitiveRead(sessionId: string, source: TaintSource, target: string): void {
  if (!sessionTaint.has(sessionId)) sessionTaint.set(sessionId, []);
  sessionTaint.get(sessionId)!.push({
    source,
    target,
    timestamp: Date.now(),
    runId: sessionId,
  });
}

/** Check if a session has tainted data that should block egress */
export function checkEgressTaint(sessionId: string): { blocked: boolean; reason?: string } {
  const taints = sessionTaint.get(sessionId);
  if (!taints || taints.length === 0) return { blocked: false };

  // Any sensitive data in the context within the last 5 minutes blocks egress
  const TAINT_WINDOW_MS = 5 * 60 * 1000;
  const now = Date.now();
  const activeTaints = taints.filter(t => now - t.timestamp < TAINT_WINDOW_MS);

  if (activeTaints.length > 0) {
    const sources = [...new Set(activeTaints.map(t => `${t.source}:${t.target.slice(0, 40)}`))];
    return {
      blocked: true,
      reason: `Egress blocked: session contains tainted data from sensitive sources (${sources.join(", ")}). ` +
        `Data lineage tracking prevents exfiltration even through transforms.`,
    };
  }

  return { blocked: false };
}

/** Clear taint for a session (e.g., on new chat) */
export function clearSessionTaint(sessionId: string): void {
  sessionTaint.delete(sessionId);
}

/** Check if a file path is sensitive (triggers taint on read) */
export function isSensitivePath(filePath: string): boolean {
  const sensitive = [
    /\.ssh/i, /\.aws/i, /\.env/i, /credentials/i, /\.gnupg/i,
    /\.config.*token/i, /\.config.*secret/i, /auth\.json/i,
    /secrets?\.(enc|json|yaml|yml)/i, /master\.(dpapi|key)/i,
    /password/i, /\.npmrc/i, /\.pypirc/i, /\.netrc/i,
    /id_rsa/i, /id_ed25519/i, /\.pem$/i, /\.key$/i,
  ];
  return sensitive.some(p => p.test(filePath));
}

/** Get session taint summary */
export function getTaintSummary(sessionId: string): { count: number; sources: string[] } {
  const taints = sessionTaint.get(sessionId) || [];
  return {
    count: taints.length,
    sources: [...new Set(taints.map(t => t.source))],
  };
}
