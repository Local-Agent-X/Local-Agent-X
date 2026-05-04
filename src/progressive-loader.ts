import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface StoredMessage {
  role: string;
  content: unknown;
  timestamp?: number;
  _ephemeral?: boolean;
}

/**
 * Middleware-nudge content prefixes that should never reach the chat UI.
 * Mirrors the legacy-string list in providers/sanitize.ts so older sessions
 * on disk (saved before the _ephemeral flag was added) get filtered at read
 * time. Live persistence path uses stripEphemeralMessages; this is the
 * defense-in-depth pass for already-polluted session JSONs.
 */
const EPHEMERAL_USER_PREFIXES = [
  "[Self-check]",
  "Your previous response was empty.",
  "Tool errors occurred but you did not address them.",
  "You do NOT need approval.",
  "You claimed to have created or scheduled",
  "You claimed to have added/updated/created/scheduled",
  "You claimed an action ",
];

function isEphemeral(m: StoredMessage): boolean {
  if (m._ephemeral === true) return true;
  if (m.role !== "user" || typeof m.content !== "string") return false;
  return EPHEMERAL_USER_PREFIXES.some((p) => (m.content as string).startsWith(p));
}

/**
 * Older sessions have `*[Stopped: ...]*` markers baked into assistant
 * content because the prior abort path appended via stream-delta. Strip
 * those on load so existing transcripts don't keep showing the AI-thoughts
 * bracket text. Matches the exact pattern emitted at run.ts:403 (now
 * removed). Idempotent — runs each load, no-op once content is clean.
 */
const LEGACY_STOPPED_RE = /\n*\*\[Stopped:[^\]]*\]\*\s*$/g;
function cleanLegacyStoppedSuffix(m: StoredMessage): StoredMessage {
  if (m.role !== "assistant" || typeof m.content !== "string") return m;
  if (!m.content.includes("*[Stopped:")) return m;
  const cleaned = m.content.replace(LEGACY_STOPPED_RE, "").trimEnd();
  return cleaned === m.content ? m : { ...m, content: cleaned };
}

interface StoredSession {
  id: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface PageResult {
  messages: StoredMessage[];
  page: number;
  pageSize: number;
  totalMessages: number;
  totalPages: number;
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 50;

function resolveSessionPath(sessionId: string): string {
  // Sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const candidates = [
    safeId,
    safeId + ".json",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Session not found: ${sessionId}`);
}

function readSession(sessionPath: string): StoredSession {
  const raw = readFileSync(sessionPath, "utf-8");
  return JSON.parse(raw);
}

export function getSessionMessageCount(sessionId: string): number {
  const session = readSession(resolveSessionPath(sessionId));
  return session.messages.length;
}

export function loadSessionPage(
  sessionId: string,
  page: number = 0,
  pageSize: number = DEFAULT_PAGE_SIZE,
): PageResult {
  const session = readSession(resolveSessionPath(sessionId));
  // Filter out middleware-nudge / ephemeral messages BEFORE pagination so
  // page indices stay stable from the user's perspective. A polluted session
  // JSON would otherwise show "page 1 of 5" with one nudge and one real
  // message per page.
  const visible = session.messages.filter((m) => !isEphemeral(m)).map(cleanLegacyStoppedSuffix);
  const totalMessages = visible.length;
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));

  // Clamp page number
  const validPage = Math.max(0, Math.min(page, totalPages - 1));

  // Load newest first, paginate backwards
  // Page 0 = most recent messages, page N = oldest messages
  const endIndex = totalMessages - validPage * pageSize;
  const startIndex = Math.max(0, endIndex - pageSize);
  const messages = visible.slice(startIndex, endIndex);

  return {
    messages,
    page: validPage,
    pageSize,
    totalMessages,
    totalPages,
    hasMore: startIndex > 0,
  };
}
