/**
 * Exact search over the stored chat transcripts: every message whose text
 * contains a phrase, word for word (case aside), tool calls and tool output
 * included, newest first. The ranked search (searchPastSessions) answers
 * "what did we say about X" from the index's top hits; this answers "where
 * did I say exactly this" and "every time Y came up" — a quoted phrase, an
 * error string, a file name. It reads the transcript files themselves, so it
 * sees what the index leaves out (tool rows) and what it has not caught up on.
 *
 * The scan skips what is nobody's conversation (isExcludedFromTranscriptSearch)
 * and every row the harness wrote (nudges, recalled memory). Masking and the
 * external-content wrap are the caller's (search-past-sessions.ts): tool
 * output in an old chat came from anywhere.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { parseSessionLogText, sessionLogMeta, type SessionLogRow, type SessionMessageRow } from "../../session-log-rows.js";
import { isExcludedFromTranscriptSearch } from "../../synthetic-sessions.js";
import { isHarnessRow } from "../../../harness-rows.js";
import { stripHarnessScaffolding } from "../../../sanitize.js";

export interface ExactHit {
  sessionId: string;
  title: string;
  messageId?: string;
  role: "user" | "assistant" | "tool";
  /** The tool a tool row answered, or the tools an assistant row called. */
  tool?: string;
  createdAt: string;
  /** Times the phrase occurs in this message. */
  count: number;
  excerpt: string;
}

export interface ExactSearchResult {
  /** Every matching message, newest first. */
  hits: ExactHit[];
  /** Matching messages per chat, every chat that has one. */
  chats: Array<{ sessionId: string; title: string; messages: number }>;
}

const EXCERPT_RADIUS = 160;

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && "text" in p && typeof (p as { text: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

type ToolCall = { id?: string; function?: { name?: string; arguments?: string } };
const toolCallsOf = (m: ChatCompletionMessageParam): ToolCall[] =>
  m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown }).tool_calls) ? (m as { tool_calls: ToolCall[] }).tool_calls : [];

/** What a message says, as searched: an assistant row's tool calls read as
 *  `name(arguments)`, the commands and paths the agent sent. */
function searchableText(m: ChatCompletionMessageParam): string {
  const body = partsText(m.content);
  if (m.role === "user") return stripHarnessScaffolding(body);
  const calls = toolCallsOf(m).map((c) => `${c.function?.name ?? "tool"}(${c.function?.arguments ?? ""})`);
  return [body, ...calls].filter(Boolean).join("\n");
}

function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

function excerptAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(text.length, at + length + EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function hitsIn(rows: SessionLogRow[], sessionId: string, needle: string, since: number): ExactHit[] {
  const title = sessionLogMeta(rows)?.title ?? "";
  const toolNames = new Map<string, string>();
  const hits: ExactHit[] = [];
  for (const row of rows) {
    if (row.kind !== "msg") continue;
    const m = (row as SessionMessageRow).message;
    for (const c of toolCallsOf(m)) if (c.id && c.function?.name) toolNames.set(c.id, c.function.name);
    if (isHarnessRow(m) || (m.role !== "user" && m.role !== "assistant" && m.role !== "tool")) continue;
    if (since && Date.parse(row.createdAt) < since) continue;
    const text = searchableText(m);
    const at = occurrences(text.toLowerCase(), needle);
    if (at.length === 0) continue;
    const called = toolCallsOf(m).map((c) => c.function?.name).filter(Boolean).join(", ");
    const tool = m.role === "tool" ? toolNames.get((m as { tool_call_id?: string }).tool_call_id ?? "") : called || undefined;
    hits.push({
      sessionId, title, messageId: row.id, role: m.role, ...(tool ? { tool } : {}),
      createdAt: row.createdAt, count: at.length, excerpt: excerptAround(text, at[0], needle.length),
    });
  }
  return hits;
}

/**
 * Every message in the stored transcripts under `dataDir` that contains
 * `phrase`. A file is parsed only when its raw text holds the phrase as JSON
 * would write it, so a scan of hundreds of megabytes reads, and rarely parses.
 */
export async function exactPastSearch(dataDir: string, phrase: string, opts: { since?: Date } = {}): Promise<ExactSearchResult> {
  const needle = phrase.toLowerCase();
  const raw = JSON.stringify(phrase).slice(1, -1).toLowerCase();
  const since = opts.since && !Number.isNaN(opts.since.getTime()) ? opts.since.getTime() : 0;
  const dir = join(dataDir, "sessions");
  const names = await readdir(dir).catch(() => [] as string[]);
  const hits: ExactHit[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") || name.startsWith(".") || isExcludedFromTranscriptSearch(name)) continue;
    const path = join(dir, name);
    const modified = since ? (await stat(path).catch(() => null))?.mtimeMs : undefined;
    if (modified !== undefined && modified < since) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    if (!text.toLowerCase().includes(raw)) continue;
    hits.push(...hitsIn(parseSessionLogText(text).map((r) => r.row), name.slice(0, -".jsonl".length), needle, since));
  }
  hits.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const chats = new Map<string, { sessionId: string; title: string; messages: number }>();
  for (const h of hits) {
    const c = chats.get(h.sessionId) ?? { sessionId: h.sessionId, title: h.title, messages: 0 };
    c.messages++;
    chats.set(h.sessionId, c);
  }
  return { hits, chats: [...chats.values()] };
}
