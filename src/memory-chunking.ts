/**
 * Memory Chunking — text splitting strategies for the memory system.
 *
 * Two strategies:
 *   1. Line-based (for markdown files, entity pages, daily logs)
 *   2. Conversation-pair (for chat sessions — preserves Q+A semantic units)
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ChunkMetadata } from "./memory.js";

// Re-export the Chunk shape used by memory.ts (avoid circular import)
export interface ChunkData {
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  metadata?: ChunkMetadata;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── Line-based chunking (for markdown / non-conversation files) ──

export function chunkText(
  content: string,
  path: string,
  source: string,
  maxChunkChars: number,
  overlapChars: number,
  metadata?: ChunkMetadata,
): ChunkData[] {
  const lines = content.split("\n");
  const chunks: ChunkData[] = [];

  let currentText = "";
  let currentStart = 1;
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentText += (currentText ? "\n" : "") + line;
    currentChars += line.length + 1;

    if (currentChars >= maxChunkChars || i === lines.length - 1) {
      if (currentText.trim()) {
        chunks.push({
          path, source, startLine: currentStart, endLine: i + 1,
          text: currentText, hash: sha256(currentText), metadata,
        });
      }

      if (i < lines.length - 1) {
        const overlapText = currentText.slice(-overlapChars);
        const overlapLines = overlapText.split("\n").length;
        currentStart = i + 2 - overlapLines;
        currentText = overlapText;
        currentChars = overlapText.length;
      } else {
        currentText = "";
        currentChars = 0;
        currentStart = i + 2;
      }
    }
  }

  return chunks;
}

// ── Conversation-pair chunking (for chat sessions) ──

const MAX_PAIR_CHARS = 3200; // ~800 tokens — one Q+A pair
const USER_PREFIX_LEN = 200; // chars of user question kept as prefix when splitting long answers

/**
 * Chunk a conversation as Q+A pairs.
 * Each user message + following assistant message(s) = one chunk.
 * Preserves the semantic unit of "question → answer."
 */
export function chunkConversationPairs(
  messages: ConversationMessage[],
  path: string,
  source: string,
  metadata: ChunkMetadata,
  maxPairChars = MAX_PAIR_CHARS,
): ChunkData[] {
  const pairs = buildPairs(messages);
  const chunks: ChunkData[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const text = formatPair(pair.user, pair.assistant);

    if (text.length <= maxPairChars) {
      chunks.push({
        path, source, startLine: i + 1, endLine: i + 1,
        text, hash: sha256(text), metadata,
      });
    } else {
      // Split long assistant responses at paragraph boundaries
      const userPrefix = pair.user.slice(0, USER_PREFIX_LEN);
      const paragraphs = pair.assistant.split(/\n\n+/);
      let buffer = "";

      for (const para of paragraphs) {
        const candidate = buffer ? buffer + "\n\n" + para : para;
        if (formatPair(userPrefix, candidate).length > maxPairChars && buffer) {
          // Flush buffer as a chunk
          chunks.push({
            path, source, startLine: i + 1, endLine: i + 1,
            text: formatPair(userPrefix, buffer), hash: sha256(formatPair(userPrefix, buffer)), metadata,
          });
          buffer = para;
        } else {
          buffer = candidate;
        }
      }
      if (buffer.trim()) {
        chunks.push({
          path, source, startLine: i + 1, endLine: i + 1,
          text: formatPair(userPrefix, buffer), hash: sha256(formatPair(userPrefix, buffer)), metadata,
        });
      }
    }
  }

  return chunks;
}

interface ConversationPair {
  user: string;
  assistant: string;
}

function buildPairs(messages: ConversationMessage[]): ConversationPair[] {
  const pairs: ConversationPair[] = [];
  let i = 0;

  while (i < messages.length) {
    if (messages[i].role === "user") {
      const userContent = messages[i].content;
      let assistantContent = "";
      i++;
      // Collect all following assistant messages
      while (i < messages.length && messages[i].role === "assistant") {
        assistantContent += (assistantContent ? "\n\n" : "") + messages[i].content;
        i++;
      }
      if (assistantContent) {
        pairs.push({ user: userContent, assistant: assistantContent });
      } else {
        // User message with no response — still worth storing
        pairs.push({ user: userContent, assistant: "(no response)" });
      }
    } else {
      // Orphan assistant message (no preceding user message)
      pairs.push({ user: "(system)", assistant: messages[i].content });
      i++;
    }
  }

  return pairs;
}

function formatPair(user: string, assistant: string): string {
  return `[user] ${user}\n\n[assistant] ${assistant}`;
}

// ── Session extraction ──

interface SessionData {
  messages: Array<{ role: string; content: unknown }>;
  createdAt?: number;
  title?: string;
}

/**
 * Extract user/assistant message pairs from an Agent X session file.
 */
export function extractSessionPairs(sessionPath: string): ConversationMessage[] {
  let session: SessionData;
  try {
    session = JSON.parse(readFileSync(sessionPath, "utf-8"));
  } catch {
    return [];
  }

  if (!session.messages || !Array.isArray(session.messages)) return [];

  const messages: ConversationMessage[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = typeof msg.content === "string"
      ? msg.content.trim()
      : Array.isArray(msg.content)
        ? msg.content.filter((p: unknown) => typeof p === "string").join(" ").trim()
        : "";
    if (!content || content.length < 3) continue;
    messages.push({ role: msg.role as "user" | "assistant", content });
  }

  return messages;
}
