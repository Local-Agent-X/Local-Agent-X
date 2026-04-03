import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "./types.js";
import { redactCredentials } from "./security.js";
import { getRuntimeConfig } from "./config.js";

// ── Multipart parser ──
export interface MultipartPart { filename?: string; name?: string; data: Buffer; contentType?: string }
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const sep = Buffer.from(`--${boundary}`);
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf(sep, pos);
    if (start === -1) break;
    const nextStart = body.indexOf(sep, start + sep.length + 2);
    if (nextStart === -1) break;
    const partBuf = body.subarray(start + sep.length + 2, nextStart - 2);
    const headerEnd = partBuf.indexOf("\r\n\r\n");
    if (headerEnd === -1) { pos = nextStart; continue; }
    const headerStr = partBuf.subarray(0, headerEnd).toString();
    const data = partBuf.subarray(headerEnd + 4);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
    parts.push({
      filename: filenameMatch?.[1],
      name: nameMatch?.[1],
      data,
      contentType: ctMatch?.[1]?.trim(),
    });
    pos = nextStart;
  }
  return parts;
}

/** Extract text from a message content field (handles string and content-block arrays) */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text.trim())
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** Extract all useful output from an agent's message history */
export function extractAgentOutput(messages: Array<{ role: string; content?: unknown }>): string {
  const assistantParts: string[] = [];
  const toolParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = extractText(msg.content);
      if (text) assistantParts.push(text);
    }
    if (msg.role === "tool") {
      const text = extractText(msg.content);
      if (text && !text.startsWith("BLOCKED") && text.length > 10) {
        toolParts.push(text.length > 500 ? text.slice(0, 500) + "..." : text);
      }
    }
  }
  // Prefer the LAST substantial assistant message (final report) over early planning chatter
  let output = "";
  if (assistantParts.length > 0) {
    const lastSubstantial = [...assistantParts].reverse().find(p => p.length > 200);
    output = lastSubstantial || assistantParts.join("\n\n");
  }
  if (!output && toolParts.length > 0) {
    output = toolParts.join("\n\n");
  }
  if (output.length > 50000) output = output.slice(0, 50000) + "\n\n[truncated]";
  return output;
}

// Session ID validation: alphanumeric + dash/underscore, max 64 chars
export function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// Strip file paths, stack traces from error messages sent to clients
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let safe = raw
    .replace(/[A-Z]:\\[^\s:'"]+/gi, "[path]")
    .replace(/\/(?:home|usr|tmp|var|Users|root|etc|mnt|opt|srv|run|proc|sys|boot|dev)\b[^\s:'"]+/gi, "[path]")
    .replace(/(?:\.\.\/){2,}[^\s:'"]+/g, "[path]")
    .replace(/\\\\[^\s:'"]+/g, "[path]")
    .replace(/\bnode_modules[/\\][^\s:'"]+/g, "[module]");
  safe = safe.replace(/\s+at\s+.+\(.+\)/g, "");
  if (safe.length > 200) safe = safe.slice(0, 197) + "...";
  return safe;
}

// ── CORS: loopback-only for mutations ──

let serverPort = "7007";
export function setServerPort(port: string) { serverPort = port; }

const LOOPBACK_ORIGINS = new Set([
  "http://localhost", "http://127.0.0.1", "http://[::1]",
  "https://localhost", "https://127.0.0.1", "https://[::1]",
]);

export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const base = `${parsed.protocol}//${parsed.hostname}`;
    if (!LOOPBACK_ORIGINS.has(base)) return false;
    const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return originPort === serverPort;
  } catch {
    return false;
  }
}

export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (origin && isLoopbackOrigin(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Vary": "Origin",
    };
  }
  return {};
}

export function jsonResponse(res: ServerResponse, status: number, data: unknown, req?: IncomingMessage) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...(req ? corsHeaders(req) : {}),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

export function sseWrite(res: ServerResponse, event: ServerEvent) {
  if (event.type === "tool_end" && event.result) {
    event = { ...event, result: redactCredentials(event.result) };
  }
  if (event.type === "stream" && event.delta) {
    event = { ...event, delta: redactCredentials(event.delta) };
  }
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BODY = getRuntimeConfig().maxRequestBodyBytes;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export { BANNED_KEYS };

export async function safeParseBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw, (key: string, value: unknown) => {
      if (BANNED_KEYS.has(key)) return undefined;
      return value;
    }) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Rate Limiting: token bucket per auth token (falls back to IP) ──

const rateLimits = new Map<string, { tokens: number; lastRefill: number }>();

export function getRateLimitKey(req: IncomingMessage): string {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) return `tok:${token.slice(0, 16)}`;
  return `ip:${req.socket.remoteAddress || "unknown"}`;
}

export function checkRateLimit(key: string): boolean {
  const cfg = getRuntimeConfig();
  const RATE_LIMIT_MAX = cfg.rateLimitMax;
  const RATE_LIMIT_REFILL_PER_SEC = cfg.rateLimitRefillPerSec;
  const now = Date.now();
  let bucket = rateLimits.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_MAX, lastRefill: now };
    rateLimits.set(key, bucket);
  }
  const elapsed = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(RATE_LIMIT_MAX, bucket.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Periodic cleanup of stale rate limit entries
setInterval(() => {
  const cutoff = Date.now() - 300_000;
  for (const [key, bucket] of rateLimits) {
    if (bucket.lastRefill < cutoff) rateLimits.delete(key);
  }
}, 300_000);

// ── Auth Flood Guard ──
const authFloodGuard = new Map<string, { failures: number; lockedUntil: number }>();

export function recordAuthFailure(ip: string): void {
  const cfg = getRuntimeConfig();
  const AUTH_MAX_FAILURES = cfg.authMaxFailures;
  const AUTH_LOCKOUT_MS = cfg.authLockoutMs;
  const entry = authFloodGuard.get(ip) || { failures: 0, lockedUntil: 0 };
  entry.failures++;
  if (entry.failures >= AUTH_MAX_FAILURES) {
    entry.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
    entry.failures = 0;
    console.warn(`[auth] IP ${ip} locked out for ${AUTH_LOCKOUT_MS / 1000}s after ${AUTH_MAX_FAILURES} failed attempts`);
  }
  authFloodGuard.set(ip, entry);
}

export function getAuthFloodGuard() { return authFloodGuard; }

// Prune stale lockouts
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFloodGuard) {
    if (entry.lockedUntil < now && entry.failures === 0) authFloodGuard.delete(ip);
  }
}, 600_000);
