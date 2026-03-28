import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface StoredMessage {
  role: string;
  content: unknown;
  timestamp?: number;
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
  // Support both direct paths and session directory lookup
  if (existsSync(sessionId)) return sessionId;
  const candidates = [
    sessionId,
    join(sessionId + ".json"),
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
  const totalMessages = session.messages.length;
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));

  // Clamp page number
  const validPage = Math.max(0, Math.min(page, totalPages - 1));

  // Load newest first, paginate backwards
  // Page 0 = most recent messages, page N = oldest messages
  const endIndex = totalMessages - validPage * pageSize;
  const startIndex = Math.max(0, endIndex - pageSize);
  const messages = session.messages.slice(startIndex, endIndex);

  return {
    messages,
    page: validPage,
    pageSize,
    totalMessages,
    totalPages,
    hasMore: startIndex > 0,
  };
}
