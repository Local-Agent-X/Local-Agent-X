/**
 * The tools each session has already sent, in the order it first sent them,
 * kept on disk.
 *
 * The tool list is part of the provider's cached prompt prefix, so a list that
 * differs from the last request's breaks the cache for everything after it. A
 * session's list only grows (tool-selection.ts unions it into every pick), and
 * each request sends it in this order: the tools the session started with,
 * then each tool loaded later (tool_search) in the order it was loaded, which
 * is also where a mid-turn load appends it (canonical-loop/tool-augmentation.ts).
 * So a new turn starts with exactly the list the last one ended with.
 *
 * Before this, the memory lived only in the server's memory and each new turn
 * rebuilt the list in catalog order: after every LAX restart, and at every
 * turn after a mid-turn load, the list changed and the next call re-read the
 * whole prompt. On Grok's chat (chat-mwzepzxs, 2026-11-27) such misses paid
 * about 260k of one turn's ~330k uncached prompt tokens.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-request.session-tool-memory");

const MAX_SESSIONS_IN_MEMORY = 500;
const sessions = new Map<string, Set<string>>();

/** A session id that is safe as a file name; anything else is kept in memory only. */
const SAFE_ID = /^[\w.-]{1,200}$/;

function fileOf(sessionId: string): string | null {
  return SAFE_ID.test(sessionId) ? join(getLaxDir(), "session-tools", `${sessionId}.json`) : null;
}

function load(sessionId: string): Set<string> | undefined {
  const known = sessions.get(sessionId);
  if (known) return known;
  const file = fileOf(sessionId);
  if (!file || !existsSync(file)) return undefined;
  try {
    const names = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(names)) return undefined;
    const set = new Set(names.filter((n): n is string => typeof n === "string"));
    keep(sessionId, set);
    return set;
  } catch (e) {
    logger.warn(`[session-tools] unreadable ${file}: ${(e as Error).message}`);
    return undefined;
  }
}

function keep(sessionId: string, set: Set<string>): void {
  if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS_IN_MEMORY) {
    sessions.delete(sessions.keys().next().value as string);
  }
  sessions.set(sessionId, set);
}

function save(sessionId: string, set: Set<string>): void {
  const file = fileOf(sessionId);
  if (!file) return;
  try {
    mkdirSync(join(getLaxDir(), "session-tools"), { recursive: true });
    writeFileSync(file, JSON.stringify([...set]));
  } catch (e) {
    logger.warn(`[session-tools] could not save ${file}: ${(e as Error).message}`);
  }
}

/** The tools this session has sent, in the order it first sent them. */
export function sessionToolsOf(sessionId: string): ReadonlySet<string> | undefined {
  return sessionId ? load(sessionId) : undefined;
}

/** Add `names` to the session's tools, after the ones it already has. Called
 *  with each selection and with each mid-turn load. */
export function rememberSessionTools(sessionId: string, names: Iterable<string>): void {
  if (!sessionId) return;
  let known = load(sessionId);
  if (!known) { known = new Set(); keep(sessionId, known); }
  const before = known.size;
  for (const name of names) known.add(name);
  if (known.size !== before) save(sessionId, known);
}

/** `tools` in the session's order; tools it has not sent yet go last, in the
 *  order given. */
export function inSessionOrder<T extends { name: string }>(sessionId: string, tools: T[]): T[] {
  const known = sessionToolsOf(sessionId);
  if (!known || known.size === 0) return tools;
  const rank = new Map([...known].map((name, i) => [name, i]));
  return tools
    .map((tool, i) => ({ tool, key: rank.get(tool.name) ?? known.size + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.tool);
}

/** Forget every session's tools, saved copies included (tests run on a temp data dir). */
export function _resetSessionToolsForTests(): void {
  sessions.clear();
  rmSync(join(getLaxDir(), "session-tools"), { recursive: true, force: true });
}
