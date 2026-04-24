/**
 * Shared agent loop guards — anti-hallucination, loop detection, self-check.
 *
 * Used by all agent loops (Standard, Codex, Anthropic) to ensure consistent
 * behavior regardless of provider.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Self-Reflection ──

export function detectUnresolvedErrors(messages: ChatCompletionMessageParam[]): string[] {
  const recentMsgs = messages.slice(-20);
  for (const m of recentMsgs) {
    if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Self-check]")) {
      return [];
    }
  }

  let lastAssistantTextIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0) {
      lastAssistantTextIdx = i;
      break;
    }
  }

  const errors: string[] = [];
  const startIdx = Math.max(lastAssistantTextIdx + 1, messages.length - 20);
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const c = m.content;
    if (/\b(BLOCKED|error|failed|timed? ?out|not found|permission denied|ENOENT|EACCES|EPERM)\b/i.test(c) && c.length < 500) {
      errors.push(c.slice(0, 200));
    }
  }

  const lastAssistant = [...recentMsgs].reverse().find(m => m.role === "assistant" && typeof m.content === "string");
  if (errors.length > 0 && lastAssistant && typeof lastAssistant.content === "string") {
    if (/\b(error|failed|couldn't|unable|issue|problem|unfortunately|sorry|block(ed)?|denied|skip(ped)?|switch(ed)?|tried|moved on|gave up|cannot|can't|workaround|alternative|instead|fallback|repeat)\b/i.test(lastAssistant.content)) {
      return [];
    }
  }
  return errors;
}

export function buildReflectionPrompt(errors: string[]): string {
  return `[Self-check] The following tool errors occurred but may not have been addressed in your response. If any are relevant to the user's request, briefly acknowledge what went wrong and suggest a fix. If they're irrelevant (e.g., optional lookups), ignore them.\n\nErrors:\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;
}

// ── Hallucination Detection ──

// Tightened regexes: only match when the agent is asking for permission or claiming actions
// "I approve" or "this was approved" should NOT match — only "requires approval", "needs your approval", etc.
const APPROVAL_HALLUCINATION_RE = /\b(requires? approval|needs? your approv(al)?|please (approve|allow|confirm) (this|the|before)|permission required|permission to proceed)\b/i;
// Match first-person claims AND directive past-tense at the start of a sentence/line.
// Catches "I added X", "Added X to the mission", "Updated the schedule", etc.
const CREATION_HALLUCINATION_RE = new RegExp(
  // Pattern 1: First-person ("I added", "I've updated", "I have created")
  "\\bI('ve| have)?\\s+(added|created|scheduled|saved|built|deployed|sent|posted|updated|edited|modified|changed|inserted|appended)\\s+",
  "i"
);
// Pattern 2: Directive past-tense at sentence start
// "Added X to Y" / "Updated the mission" / "- Added: ..." / "* Updated ..."
const CREATION_HALLUCINATION_RE_2 = new RegExp(
  "(^|\\n)\\s*[-*]?\\s*(Added|Created|Scheduled|Saved|Updated|Edited|Modified|Inserted|Appended|Removed|Deleted)\\b",
  "i"
);
// (Removed CREATION_HALLUCINATION_RE_3 — it matched legitimate completion
// summaries like "Done — created the file" that DID come from real tool calls.
// TOOL_ID_HALLUCINATION_RE below catches the actually dangerous case of the
// model inventing an ID without calling a tool.)
// Match fake tool IDs: prefix-style (sched_/job_/cron_) AND short hex strings
// presented as "Job ID: 5a0fb8ae" / "ID: abc12345" / "Schedule ID: ..."
const TOOL_ID_HALLUCINATION_RE = new RegExp(
  "(\\b(sched_|job_|cron_)[a-zA-Z0-9_-]{6,})|" +
  "(\\b(Job|Schedule|Mission|Task|Run)\\s*ID[:=]?\\s*[`\"']?[a-f0-9]{6,16}[`\"']?\\b)",
  "i"
);

/** Returns a nudge message if the assistant hallucinated approval, or null. */
export function checkApprovalHallucination(text: string): string | null {
  if (APPROVAL_HALLUCINATION_RE.test(text)) {
    return "You do NOT need approval. You have full permission to run any tool. Call the bash tool directly — do not ask for permission.";
  }
  return null;
}

/** Returns a nudge message if the assistant claimed a creation without calling a tool, or null. */
export function checkCreationHallucination(text: string): string | null {
  if (
    CREATION_HALLUCINATION_RE.test(text) ||
    CREATION_HALLUCINATION_RE_2.test(text) ||
    TOOL_ID_HALLUCINATION_RE.test(text)
  ) {
    return "You claimed to have added/updated/created/scheduled something but you did NOT actually call a tool. The change did NOT happen. Do NOT invent IDs. Call the actual tool now (mission_schedule_create with name/schedule/prompt for new missions, mission_schedule_update for edits, write for files, etc).";
  }
  return null;
}

// ── Tool-verified hallucination check ──
//
// The iteration===0 gate on checkCreationHallucination misses hallucinations
// that happen on iteration N where the agent made SOME tool call on iter 0
// but then claimed a different, un-executed action at the end. This check
// closes that gap by requiring that any claimed action verb maps to a tool
// that was actually called this turn.

/**
 * Verb classes → tool names that perform that verb. If the assistant claims
 * an action in one of these classes and NONE of the listed tools was called
 * this turn, that's a hallucinated action.
 *
 * Add entries when new action-style tools land. Missing a mapping produces a
 * false positive (nudge when work was legit) — that's annoying but not
 * dangerous. Missing an entry in the verb regex produces a false NEGATIVE
 * (real hallucination slips through) — that's the worse failure mode, so
 * keep the verb regex tight and the tool list generous.
 */
const ACTION_VERB_TO_TOOLS: Array<{ verb: RegExp; tools: string[] }> = [
  // "removed/unpinned/deleted X" — lots of tools can remove state
  { verb: /\b(removed?|unpinned?|deleted?|dropped?|cleared?|unscheduled?)\b/i, tools: [
    "sidebar_unpin", "secret_delete", "cron_delete", "bash", "memory_delete",
    "http_request", "delete", "browser", "agent_cancel", "mission_cancel",
    "skill_remove", "cron_toggle", "email_draft",
  ] },
  // "added/pinned/scheduled/created X"
  { verb: /\b(added?|pinned?|scheduled|created|wrote|built|saved|installed)\b/i, tools: [
    "sidebar_pin", "secret_save", "browser_capture_to_secret", "cron_create",
    "mission_schedule_create", "memory_save", "memory_update_profile", "write",
    "build_app", "skill_install", "http_request", "agent_spawn", "delegate",
    "email_setup", "operation_start", "bash", "edit",
  ] },
  // "sent/posted/emailed/messaged"
  { verb: /\b(sent|posted|emailed|messaged|tweeted|published|mailed)\b/i, tools: [
    "email_send", "email_draft", "whatsapp_send", "telegram_send", "http_request",
    "browser",
  ] },
  // "updated/edited/modified/changed/renamed" — sidebar_pin/unpin deliberately
  // excluded here. "Update X" on app content is about writing/editing files,
  // not pinning to the sidebar. Including sidebar tools in this verb class
  // created false-positive hallucination pressure that biased toward pins.
  { verb: /\b(updated?|edited?|modified|changed|renamed|patched|configured)\b/i, tools: [
    "edit", "write", "http_request", "secret_save", "memory_update_profile",
    "cron_update", "mission_schedule_update", "email_setup", "browser", "bash",
  ] },
];

const CLAIM_AT_REPLY_START_RE = /(?:^|\n)\s*[-*]?\s*(Removed|Unpinned|Deleted|Dropped|Cleared|Unscheduled|Added|Pinned|Scheduled|Created|Wrote|Built|Saved|Installed|Sent|Posted|Emailed|Messaged|Published|Mailed|Updated|Edited|Modified|Changed|Renamed|Patched|Configured)\b/i;
const CLAIM_FIRST_PERSON_RE = /\bI('ve| have)?\s+(removed|unpinned|deleted|dropped|cleared|unscheduled|added|pinned|scheduled|created|wrote|built|saved|installed|sent|posted|emailed|messaged|published|mailed|updated|edited|modified|changed|renamed|patched|configured)\b/i;

/**
 * Return a nudge if the assistant's reply claims an action verb whose
 * matching tools were NOT called this turn. Pass the list of tool NAMES
 * invoked anywhere in the current turn (across all iterations).
 */
export function checkUnmatchedActionClaim(
  text: string,
  toolsCalledThisTurn: Set<string>,
): string | null {
  if (!text) return null;
  if (!CLAIM_AT_REPLY_START_RE.test(text) && !CLAIM_FIRST_PERSON_RE.test(text)) return null;

  // Find which verb classes the reply claims
  const claimedVerbs: string[] = [];
  const missingTools: string[][] = [];
  for (const entry of ACTION_VERB_TO_TOOLS) {
    if (!entry.verb.test(text)) continue;
    const matched = entry.tools.some(t => toolsCalledThisTurn.has(t));
    if (!matched) {
      claimedVerbs.push(entry.verb.source.replace(/[()\\b?]/g, "").split("|")[0]);
      missingTools.push(entry.tools);
    }
  }
  if (claimedVerbs.length === 0) return null;

  const expected = Array.from(new Set(missingTools.flat())).slice(0, 6).join(", ");
  return (
    `You claimed an action (${claimedVerbs.join(", ")}) but no matching tool was called this turn. ` +
    `Tools actually called: ${Array.from(toolsCalledThisTurn).join(", ") || "(none)"}. ` +
    `Call one of the matching tools now (${expected}), or correct your reply if the action was actually not done.`
  );
}

// ── Loop Detection ──

export interface LoopState {
  lastToolKey: string;
  sameToolCount: number;
  toolNameCounts: Map<string, number>;
}

export function createLoopState(): LoopState {
  return { lastToolKey: "", sameToolCount: 0, toolNameCounts: new Map() };
}

const DISCOVERY_LOOP_THRESHOLD = 8;
const DISCOVERY_LOOP_THRESHOLD_WEAK = 4;

/**
 * Check for exact-repeat loops and discovery loops. Weak/medium models
 * loop harder and faster than strong ones, so we halve the thresholds:
 * exact-repeat fires at 2x instead of 3x, discovery at 4 instead of 8.
 * Returns a nudge message if a loop is detected, or null.
 */
export function checkToolLoops(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
  opts?: { modelTier?: "weak" | "medium" | "strong" },
): { abort: boolean; nudge: string | null } {
  const isWeakOrMedium = opts?.modelTier === "weak" || opts?.modelTier === "medium";
  const repeatLimit = isWeakOrMedium ? 2 : 3;
  const discoveryLimit = isWeakOrMedium ? DISCOVERY_LOOP_THRESHOLD_WEAK : DISCOVERY_LOOP_THRESHOLD;

  // Exact-repeat detection
  const key = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join("|");
  if (key === state.lastToolKey) {
    state.sameToolCount++;
    if (state.sameToolCount >= repeatLimit) {
      try { import("./retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "loop-abort", tool: toolCalls[0]?.name, detail: { repeatLimit, modelTier: opts?.modelTier } })).catch(() => {}); } catch {}
      return { abort: true, nudge: "\n\n(Detected repeated tool calls — stopping loop)" };
    }
  } else {
    state.sameToolCount = 1;
    state.lastToolKey = key;
  }

  // Discovery-style loop detection: same READ-ONLY discovery tool called 8+
  // times suggests the agent is spinning trying to find something. Action
  // tools (browser, http_request) are intentionally NOT in this list — they
  // do progressive work and 8+ sequential calls is normal multi-step
  // automation, not a spiral. Exact-repeat detection above (3x same call
  // with identical args) catches true browser loops.
  for (const tc of toolCalls) {
    state.toolNameCounts.set(tc.name, (state.toolNameCounts.get(tc.name) || 0) + 1);
  }
  const SPIRALABLE_TOOLS = new Set([
    "glob", "web_search", "read", "grep",
    "agent_whoami", "agent_team_list", "issue_list", "issue_search",
    "memory_search", "memory_recall", "memory_get",
    "task_list", "operation_status", "operation_list",
  ]);
  const stuck = [...state.toolNameCounts.entries()].find(([name, count]) =>
    count >= discoveryLimit && SPIRALABLE_TOOLS.has(name)
  );
  if (stuck) {
    const [toolName, count] = stuck;
    state.toolNameCounts.set(toolName, 0);
    return {
      abort: false,
      nudge: `SYSTEM: You have called ${toolName} ${count} times. STOP. Produce your final result with the information you already have, or report the blocker. Do NOT make more ${toolName} calls.`,
    };
  }

  return { abort: false, nudge: null };
}

// ── Dead-end detector ──
// A tool returned empty/null/zero results N times in a row. Instead of
// grinding the same wrong approach forever (grep 50 files, 0 matches, grep
// 50 more files, 0 matches...), nudge the agent to step back and reconsider
// which tool matches the goal.

export interface DeadEndState { consecutive: number; lastWasEmpty: boolean }

export function createDeadEndState(): DeadEndState {
  return { consecutive: 0, lastWasEmpty: false };
}

const EMPTY_RESULT_RE = /^\s*(\(no output\)|\[\]|\{\}|null|none|No results?|0 results?|Nothing found|No matches|No relevant memor|Command failed)/i;
// Progress-style empty: "Searched 800 files, 0 results" — catches long-running
// grep/find that scans forever without finding anything.
const PROGRESS_EMPTY_RE = /Searched\s+\d+\s+files?,\s*0\s+results?/i;

/** Scan a tool result for "empty" signals and update dead-end state. */
export function checkDeadEnd(
  toolName: string,
  toolResult: string,
  state: DeadEndState,
): { nudge: string | null } {
  // Trim to first 400 chars — that's where "no output" / "0 results" land
  const head = (toolResult || "").slice(0, 400);
  const tail = (toolResult || "").slice(-800);
  const isEmpty =
    head.trim().length === 0 ||
    EMPTY_RESULT_RE.test(head) ||
    PROGRESS_EMPTY_RE.test(head) || PROGRESS_EMPTY_RE.test(tail);
  if (isEmpty) {
    state.consecutive++;
    state.lastWasEmpty = true;
  } else {
    state.consecutive = 0;
    state.lastWasEmpty = false;
  }

  // After 3 empty results in a row, force a rethink
  if (state.consecutive >= 3) {
    state.consecutive = 0; // reset so we don't spam the same nudge
    return {
      nudge:
        `SYSTEM: Your last 3 tool calls returned no results. You're going down the wrong path. ` +
        `STOP, reconsider the goal, and pick a DIFFERENT tool or approach. ` +
        `If you were searching files, maybe you need an API call. ` +
        `If you were using ${toolName}, try tool_search to discover alternatives. ` +
        `Do NOT repeat the same approach.`,
    };
  }
  return { nudge: null };
}
