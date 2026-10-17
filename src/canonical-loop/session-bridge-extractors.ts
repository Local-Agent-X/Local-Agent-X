/**
 * op_messages scanner helpers for the session-bridge observer.
 *
 * These read an op's persisted messages (via the canonical readOpMessages)
 * and pull user-surfaceable bits out of them — the final assistant text a
 * delegating parent needs, plus the "Open" affordance markers (APP_READY,
 * "Created <path>", etc.) the AGENTS sidebar renders. Split out of
 * session-bridge-observer.ts to keep that module under the source-hygiene
 * LOC gate; behavior is unchanged. Depends only on the canonical op_messages
 * reader and content extractor, plus VERIFICATION_OP_TYPE for the verdict
 * headline below (a constant, not an observer/bridge dep).
 */
import { resolve } from "node:path";
import { readOpMessages } from "./store.js";
import { VERIFICATION_OP_TYPE } from "./verification-spend.js";
import { extractText } from "./turn-loop/content-extract.js";
import { OP_TYPE } from "../ops/op-types.js";
import type { Op } from "../ops/types.js";
import { cronJobIdOf } from "../cron/cron-session.js";
import { getRuntimeConfig } from "../config.js";

/**
 * Where a completed op's result opens — the one answer the AGENTS card, the
 * chat nudge and the inbox item share. Most specific first, so a tool that
 * emits an explicit marker wins over a generic "Created <path>" scan:
 *   1. an app build's known URL (op.appUrl), else its APP_READY marker;
 *   2. a scheduled mission: the job's latest-report page;
 *   3. the newest artifact a tool_result says it created (a document,
 *      presentation, pdf, sheet, page, …).
 * Only for a completed op: a failed or partial run must not offer a link to a
 * half-written artifact.
 */
export function resultUrlOfOp(opId: string, op: Pick<Op, "type" | "appUrl"> | null | undefined, sessionId?: string): string | undefined {
  let url: string | undefined;
  if (op?.type === OP_TYPE.appBuild) url = op.appUrl || extractAppReadyUrl(opId);
  else if (op?.type === OP_TYPE.scheduledMission) {
    const jobId = sessionId ? cronJobIdOf(sessionId) : undefined;
    if (jobId) url = `/api/cron/${jobId}/reports/latest`;
  }
  if (url) return url;
  try {
    return extractArtifactUrl(opId, resolve(getRuntimeConfig().workspace));
  } catch {
    return undefined; // config not ready / workspace unresolvable: no link
  }
}

/** Is this per-value row's `match?` cell a NO? Tolerant of the spellings
 *  models actually emit for that column. */
function isMismatchRow(row: string): boolean {
  const cells = row.split("|").map((c) => c.replace(/[*_`]/g, "").trim()).filter(Boolean);
  const last = (cells[cells.length - 1] ?? "").toLowerCase();
  return last === "no" || last.startsWith("no ") || last === "x" || last === "\u2717" || last === "\u274c";
}

/**
 * Spoken form of a VERIFICATION verdict — a HEADLINE, never the table.
 *
 * The generic path below reads the op's final text aloud, and a verdict's
 * final text is the brief's mandated per-value table. TTS therefore recited
 * it row by row INCLUDING the markdown separator, as "dash dash dash dash".
 * The table is what the text surfaces are for; voice gets the verdict word
 * and how many values moved, and the user can ask for the rest.
 */
function toSpokenVerdict(summary: string): string {
  const lines = (summary || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const verdictLine = lines.find((l) => /VERDICT\s*:/i.test(l)) ?? "";
  const verdict = (verdictLine.match(/VERDICT\s*:\s*([A-Za-z]+)/i)?.[1] ?? "").toUpperCase();
  // Per-value rows: pipe-delimited, minus the header row and any `---`
  // separator rendered under it (the row that made this sound like morse).
  const rows = lines.filter((l) => l.includes("|") && !/^[|\s:-]+$/.test(l)).slice(1);
  const checked = rows.length;
  const noun = `${checked} checked value${checked === 1 ? "" : "s"}`;
  if (verdict === "CONFIRMED") {
    return checked > 0
      ? `Verification finished: confirmed. All ${noun} matched.`
      : "Verification finished: confirmed.";
  }
  if (verdict === "DISCREPANCIES") {
    const mismatched = rows.filter(isMismatchRow).length;
    return mismatched > 0 && checked > 0
      ? `Verification finished: discrepancies on ${mismatched} of ${noun}.`
      : "Verification finished: discrepancies found. The details are in the chat.";
  }
  if (verdict === "UNVERIFIABLE") {
    return "Verification finished: unverifiable. Independent figures could not be obtained.";
  }
  return "Verification finished. The verdict is in the chat.";
}

/** Transcript row for a redirect the worker actually consumed. Plain assistant
 *  row, matching agentCompleteChatRow — a `system` row would be stripped by the
 *  next turn's persist filter, which keeps only compaction summaries. */
export function redirectAppliedRow(task: string, text: string): string {
  const who = task ? ` to “${task.replace(/\s+/g, " ").trim().slice(0, 60)}”` : "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean
    ? `**Redirect delivered${who}:** ${clean.slice(0, 500)}`
    : `**Redirect delivered${who}.**`;
}

/** A short, TTS-friendly line for a finished background op (no markdown, capped
 *  length). Spoken proactively when the user is in voice; the chat UI gets the
 *  full bg_op_completed event separately. `opType` routes a verification
 *  verdict to the headline above instead of reading its table aloud. (Lives
 *  here, with the observer's other presentation helpers, to keep
 *  session-bridge-observer.ts under the LOC gate.) */
export function toSpokenCompletion(task: string, summary: string, status: string, opType?: string): string {
  const clean = (summary || "").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
  const failed = status === "failed" || status === "cancelled";
  if (!failed && opType === VERIFICATION_OP_TYPE) return toSpokenVerdict(summary);
  const lead = failed ? "Heads up — that background task ran into trouble" : "Quick update — that background task finished";
  if (!clean) {
    const what = task ? ` (${task.slice(0, 60)})` : "";
    return `${lead}${what}.`;
  }
  return `${lead}: ${clean.slice(0, 280)}`;
}

// Strip trailing chars that are never valid URL tails — bold/italic markdown
// (`**`, `*`, `_`), sentence punctuation, closing brackets. Live failure
// 2026-05-23: agent emitted `**APP_READY: <url>**`, regex captured the
// trailing `**`, the rendered sidebar link 404'd while the apps-page link
// worked.
function trimUrlNoise(url: string): string {
  return url.replace(/[*)\]>.,;:'"`!?]+$/, "");
}

/** Scan an op's persisted messages for the final assistant turn and
 *  pull out the APP_READY: <url> marker the build_app adapter emits.
 *  Returns the URL string, or undefined if the marker isn't present. */
export function extractAppReadyUrl(opId: string): string | undefined {
  try {
    const messages = readOpMessages(opId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const content = m.content as { text?: string } | string | undefined;
      const text = typeof content === "string" ? content : content?.text;
      if (!text) continue;
      const match = text.match(/APP_READY:\s*(\S+)/);
      if (match) return trimUrlNoise(match[1]);
      return undefined;
    }
  } catch { /* malformed op-messages — return undefined */ }
  return undefined;
}

/** Scan an op's persisted tool_result messages for "Created <path>" /
 *  "Wrote ... to <path>" markers from the artifact-creating tools
 *  (the document, presentation, pdf, and spreadsheet tools,
 *  write, create_page, etc.). Returns the MOST RECENT openable artifact's
 *  workspace-relative path, or undefined if none found. Strict
 *  workspace-only filter — host paths outside the workspace are skipped
 *  so the sidebar never offers a link the static handler can't serve.
 *
 *  Used by the generic completion path: any worker op (not just
 *  app_build) gets the same "↗ Open" affordance in the AGENTS sidebar.
 *  The user's framing: "any agent creation wired into that — apps,
 *  landing pages, ppt, docs everything." This is the same wiring,
 *  just with a broader marker set.
 */
export function extractArtifactUrl(opId: string, workspaceDir: string): string | undefined {
  try {
    const messages = readOpMessages(opId);
    // Walk newest-first; first hit wins. Tool outputs we recognize:
    //   "Created /abs/path/foo.docx (...)"           → document, presentation, pdf, spreadsheet
    //   "Wrote N bytes to /abs/path/foo.html"        → write
    //   "Edited /abs/path/foo.css"                   → edit
    //   "App built ... Open: http://127.0.0.1:.../" → build_app (separate APP_READY path also works)
    // We deliberately don't try to extract from prose — only from
    // structured tool_result strings, which are stable.
    // Forward slashes on both sides: a Windows tool_result spells the path
    // with a drive letter and backslashes.
    const slashes = (p: string) => p.replace(/\\/g, "/");
    const wsAbs = slashes(workspaceDir).replace(/\/?$/, "/");
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool_result") continue;
      const content = m.content as { text?: string; result?: string } | string | undefined;
      const text = typeof content === "string"
        ? content
        : (content?.result ?? content?.text ?? "");
      if (!text) continue;
      // Most precise: a build_app-style explicit URL line.
      const urlMatch = String(text).match(/Open:\s*(https?:\/\/\S+)/);
      if (urlMatch) return trimUrlNoise(urlMatch[1]);
      // Generic "Created <abs-path>" / "Wrote N bytes to <abs-path>" patterns.
      const created = String(text).match(/(?:Created|Wrote (?:\d+ bytes? )?to|Edited)\s+((?:[A-Za-z]:)?[\\/]\S+)/);
      if (!created) continue;
      const absPath = slashes(trimUrlNoise(created[1]));
      // Workspace-bound only — sidebar links go through the static handler.
      if (!absPath.startsWith(wsAbs)) continue;
      const rel = absPath.slice(wsAbs.length);
      // For HTML/index files we want the directory link, not the file.
      if (rel.endsWith("/index.html")) return "/apps/" + rel.slice(0, -"/index.html".length) + "/";
      // /apps/ serves anything under workspace/apps/; any other workspace
      // file is served under /files/<workspace-relative path> (the agent
      // origin, server/static-assets.ts), which the UI opens in its program
      // or renders inline. A /workspace/ link was offered here before and
      // nothing served it.
      return rel.startsWith("apps/") ? "/" + rel : "/files/" + rel;
    }
  } catch { /* malformed op-messages — return undefined */ }
  return undefined;
}

/** Read an op's persisted messages and return the text of its FINAL assistant
 *  turn — the worker's actual result/answer — truncated to `maxChars`. This is
 *  the piece a delegating parent needs surfaced: op_wait, op_status, and the
 *  completion notification all reuse it instead of a content-free
 *  "task completed". Walks newest-first for the most recent assistant turn that
 *  carries text (a pure tool-call turn has none), reusing the canonical
 *  op_messages reader (readOpMessages) and the canonical content extractor
 *  (extractText) — no bespoke op_messages parsing. Returns "" when there's no
 *  assistant text to show. */
export function extractFinalAssistantText(opId: string, maxChars = 2000): string {
  try {
    const messages = readOpMessages(opId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const text = extractText(m.content).trim();
      if (!text) continue; // pure tool-call turn — keep looking for the last texted one
      return text.length > maxChars ? text.slice(0, maxChars).trimEnd() + "…" : text;
    }
  } catch { /* malformed op-messages — nothing to surface */ }
  return "";
}

/**
 * Op types that never surface in the AGENTS sidebar, never queue a pending
 * notification and never schedule an idle nudge. They STILL take the terminal
 * release branch in session-bridge-observer.ts recordCanonicalEventWithSink (see the leak note there).
 *
 *   chat_turn     the chat reply itself (WS stream channel), not a worker card
 *   agent_spawn   handler-events emits the named-agent card; this doubled it
 *   voice_turn    one per utterance; the reply is TTS audio, not a card
 *   skill_review  background-jobs/skill-review.ts — headless post-turn audit,
 *                 bound by trackOpForSession to its synthetic fork session
 *                 (skill-review-<ts>-<seq>). bg_op_* is a GLOBAL chat-WS
 *                 family, so every client saw "Worker: <untrusted-recalled-
 *                 data …> FAILED" cards plus a "hit a snag" idle nudge.
 *
 * NOT here on purpose: memory_consolidation — its bg_op_queued/started (with
 * opType) are the only feed for the ambient "dreaming" group
 * (public/js/chat-agent-feeds-ambient.js). Suppressing it empties that group.
 */
const SIDEBAR_SUPPRESSED_OP_TYPES: ReadonlySet<string> = new Set([
  OP_TYPE.chatTurn, OP_TYPE.agentSpawn, OP_TYPE.voiceTurn, OP_TYPE.skillReview,
]);

export function isSidebarSuppressedOpType(opType: string): boolean {
  return SIDEBAR_SUPPRESSED_OP_TYPES.has(opType);
}
