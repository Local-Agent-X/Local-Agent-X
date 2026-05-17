/**
 * Shared agent loop guards — anti-hallucination, loop detection, self-check.
 *
 * Used by all agent loops (Standard, Codex, Anthropic) to ensure consistent
 * behavior regardless of provider.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { logRetry } from "./retry-telemetry.js";
import { isEmptyResultText } from "./errors/index.js";

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

// Strip fenced and indented code blocks before running claim detectors.
// Live failure (2026-05-05): user asked "give me a prompt to hand to Claude",
// agent emitted a long markdown response with the prompt inside ``` fences.
// CREATION_HALLUCINATION_RE_2 matches lines starting with "Add/Update/Save/...",
// which fired on bullet lines INSIDE the quoted prompt — content the agent was
// drafting for someone else, not actions it was claiming. Each false hit
// triggered a re-iteration nudge, producing 4 redrafted prompts in one
// response (109k tokens, $0.63). Quoted/code content never represents the
// agent's own first-person claim and must be excluded from detection.
function stripCodeBlocks(text: string): string {
  if (!text) return text;
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/(^|\n)( {4,}|\t)[^\n]*/g, "$1");
}

/** Returns a nudge message if the assistant hallucinated approval, or null. */
export function checkApprovalHallucination(text: string): string | null {
  const cleaned = stripCodeBlocks(text);
  if (APPROVAL_HALLUCINATION_RE.test(cleaned)) {
    return "You do NOT need approval. You have full permission to run any tool. Call the bash tool directly — do not ask for permission.";
  }
  return null;
}

/** Returns a nudge message if the assistant claimed a creation without calling a tool, or null. */
export function checkCreationHallucination(text: string): string | null {
  const cleaned = stripCodeBlocks(text);
  if (
    CREATION_HALLUCINATION_RE.test(cleaned) ||
    CREATION_HALLUCINATION_RE_2.test(cleaned) ||
    TOOL_ID_HALLUCINATION_RE.test(cleaned)
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
  // "noted/remembered/recorded/logged X" — memory-specific claim verbs.
  // Real-world failure: model says "noted, I'll remember that" or "got it,
  // saved" without calling memory_save/memory_update_profile. This guard
  // forces a retry — the model has to either actually call the tool or
  // rephrase its reply to not claim the action. Same pattern as the other
  // verb classes; just specifically scoped to memory tools so other
  // claims ("noted in the bash log") don't false-positive into needing
  // memory_save. Includes both present-tense ("remember", "bookmark") and
  // past-tense ("remembered", "bookmarked") because future-tense claims
  // ("I'll remember that") are hollow promises that need the same retry.
  { verb: /\b(notes?|noted|remembers?|remembered|records?|recorded|logs?|logged|bookmarks?|bookmarked|memorizes?|memorized|stores?|stored)\b/i, tools: [
    "memory_save", "memory_update_profile",
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

const CLAIM_AT_REPLY_START_RE = /(?:^|\n)\s*[-*]?\s*(Removed|Unpinned|Deleted|Dropped|Cleared|Unscheduled|Added|Pinned|Scheduled|Created|Wrote|Built|Saved|Installed|Sent|Posted|Emailed|Messaged|Published|Mailed|Updated|Edited|Modified|Changed|Renamed|Patched|Configured|Noted|Remembered|Recorded|Logged|Bookmarked|Memorized|Stored)\b/i;
// First-person claim — past tense for completed actions ("I saved X") plus
// present/future-tense forms for memory verbs ("I'll remember", "I'll note",
// "I will bookmark"). The future tense is treated as a claim too because
// "I'll remember that" without a memory tool call is a hollow promise — the
// model commits to durable storage that won't actually happen unless we
// force the retry. Non-memory verbs stay past-tense-only (claiming "I'll
// send the email" is normal in-task language and shouldn't trigger a retry).
const CLAIM_FIRST_PERSON_RE = /\bI(?:'ve|'ll| have| will)?\s+(removed|unpinned|deleted|dropped|cleared|unscheduled|added|pinned|scheduled|created|wrote|built|saved|installed|sent|posted|emailed|messaged|published|mailed|updated|edited|modified|changed|renamed|patched|configured|noted?|remembers?|remembered|records?|recorded|logs?|logged|bookmarks?|bookmarked|memorizes?|memorized|stores?|stored)\b/i;

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
  const cleaned = stripCodeBlocks(text);
  if (!cleaned) return null;
  if (!CLAIM_AT_REPLY_START_RE.test(cleaned) && !CLAIM_FIRST_PERSON_RE.test(cleaned)) return null;
  text = cleaned; // downstream verb-class regex tests use the cleaned form too

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

// ── Task anchor reminder (Codex anti-drift) ──
// Long agentic loops cause Codex to lose the original task in context bloat.
// By the time the model has 30 tool results stacked behind it, the user's
// original message is buried — and Codex defaults to asking for clarification
// instead of finishing. Re-anchor every N tool calls.

const ANCHOR_REMINDER_INTERVAL = 5;
const ACTION_TOOLS_FOR_ANCHOR = new Set(["write", "edit", "build_app", "self_edit", "bash"]);

export interface TaskAnchorState {
  totalToolCalls: number;
  lastReminderAt: number;
}

export function createTaskAnchorState(): TaskAnchorState {
  return { totalToolCalls: 0, lastReminderAt: 0 };
}

/**
 * Returns a re-anchor reminder string when total tool calls hits the next
 * ANCHOR_REMINDER_INTERVAL multiple, else null. Caller pushes the returned
 * string as a `user`-role message into the conversation so the next API
 * call sees it before the model decides what to do next.
 */
export function checkTaskAnchor(
  toolCallsThisIteration: number,
  state: TaskAnchorState,
  originalUserMessage: string,
  toolsCalledThisTurn: Set<string>,
): string | null {
  state.totalToolCalls += toolCallsThisIteration;
  if (state.totalToolCalls < state.lastReminderAt + ANCHOR_REMINDER_INTERVAL) return null;
  state.lastReminderAt = state.totalToolCalls;

  const truncated = originalUserMessage.length > 280
    ? originalUserMessage.slice(0, 280) + "..."
    : originalUserMessage;
  const acted = [...ACTION_TOOLS_FOR_ANCHOR].filter(t => toolsCalledThisTurn.has(t));

  return (
    `[Task anchor — ${state.totalToolCalls} tool calls so far] Original request:\n` +
    `> "${truncated}"\n\n` +
    (acted.length > 0
      ? `You've already taken concrete action: ${acted.join(", ")}. If those changes solve the request, FINALIZE NOW with a brief summary of what you changed and stop. Don't ask the user for more context after acting.`
      : `If you have enough context to act, take action now (write/edit/bash). If not, ask ONE focused question and stop. Don't keep grinding through reads.`)
  );
}

// ── Acted-and-asked detector (Codex bias correction) ──
// Codex's RLHF heavily trained "ask if uncertain" behaviors that conflict
// with autonomous work. After making real edits, it often defaults back to
// "I'm missing the actual task context. What file should I modify?" — even
// though it just modified two files. Catch this and push back.

const QUESTION_AT_END_RE = /\?\s*$|\?\s*\n\s*$/;
const QUESTION_OPENERS_RE = /\b(what (file|app|should i|do you)|which (file|app|one)|do you want|please clarify|i'?m missing|missing.*context|need more (info|context|detail))\b/i;
const ACTION_TOOLS_FOR_ASKED = new Set(["write", "edit", "build_app", "self_edit"]);

/**
 * Detects "acted AND asked in the same turn" — the model made real edits
 * but ended its turn with a clarifying question instead of a summary.
 * Returns a nudge that pushes the model to either commit (summarize what
 * it did) or undo (and explain why), but not both.
 *
 * Returns null if:
 *   - No action tools were called this turn (just asking is fine)
 *   - The reply doesn't end in / open with a clarifying question
 *   - The reply already references what was done ("I just edited X, but
 *     I want to confirm Y" — that's legit confirmation, not drift)
 */
export function checkActedAndAsked(
  text: string,
  toolsCalledThisTurn: Set<string>,
): string | null {
  if (!text || text.length < 20) return null;
  const acted = [...ACTION_TOOLS_FOR_ASKED].filter(t => toolsCalledThisTurn.has(t));
  if (acted.length === 0) return null;

  const looksLikeQuestion = QUESTION_AT_END_RE.test(text) || QUESTION_OPENERS_RE.test(text);
  if (!looksLikeQuestion) return null;

  // Skip if the reply explicitly references the edits (legitimate confirmation)
  if (/\b(I (just |already )?(edited|wrote|modified|updated|changed)|the (edit|change|fix) (i|i've) (made|applied))\b/i.test(text)) {
    return null;
  }

  return (
    `You called ${acted.join(", ")} this turn — that's an action, not a question. ` +
    `Don't ask the user for more context after editing files. Pick ONE:\n` +
    `(1) FINISH: produce a 1-2 sentence summary of exactly what you changed and stop, OR\n` +
    `(2) UNDO: if your edits were wrong, revert them with a corresponding edit/write call and explain why you can't proceed.\n` +
    `Do not both act AND ask in the same turn.`
  );
}

// ── Loop Detection ──

export interface LoopState {
  lastToolKey: string;
  sameToolCount: number;
  toolNameCounts: Map<string, number>;
  // Iterations elapsed since the last MUTATING tool call (write/edit/commit).
  // Build_app worker spun 96 bash calls + 0 file changes for 5 min before kill.
  // No-progress detector: if this exceeds NO_PROGRESS_LIMIT iterations, abort.
  iterationsSinceMutation: number;
  // Set to true on the iteration AFTER a successful `git commit` is observed
  // in a bash tool result. Next iteration the agent gets a nudge to wrap up.
  // The perma-fix mandate keeps agents going past their commit; this caps it.
  postCommitNudgePending: boolean;
}

export function createLoopState(): LoopState {
  return {
    lastToolKey: "",
    sameToolCount: 0,
    toolNameCounts: new Map(),
    iterationsSinceMutation: 0,
    postCommitNudgePending: false,
  };
}

const DISCOVERY_LOOP_THRESHOLD = 8;
const DISCOVERY_LOOP_THRESHOLD_WEAK = 4;
// No-progress abort: iterations of consecutive non-mutating tool calls allowed
// before the agent is forced to end its turn. Raised from 12/6 → 25/15 after
// "research the latest tech in X and make a powerpoint" aborted at 6 web_search
// calls — research-then-build workflows legitimately need many read-only steps
// (web_search, web_fetch, snapshot, page extract, image search) before the
// first file write. The discovery-loop detector at DISCOVERY_LOOP_THRESHOLD
// still catches true spirals (8x identical tool); this guard is the backup
// for an agent that's genuinely stuck across many different tools.
export const NO_PROGRESS_LIMIT = 25;
export const NO_PROGRESS_LIMIT_WEAK = 15;
// A mutation is a tool that committed *real-world* work — disk write, page
// click, HTTP POST, message sent. Note `bash` is NOT here despite being in
// PROGRESS_TOOLS for the spiralable-reset logic — bash can spin without
// producing changes (git status loops, grep loops). The other read-only
// tools (`read`, `grep`, `glob`, `web_search`, `snapshot`-style ops) are
// also excluded — those genuinely don't change anything.
//
// Live failure (2026-05-13, the customer PO-entry workflow on codex): agent drove
// the browser through 6 form-fill / click iterations without writing a
// single file. Each `browser` call was real progress (PO number set,
// vendor field populated, line items being added) but the no-progress
// guard saw "zero file mutations" and aborted the turn with
// "No-progress abort: 6+ iterations of tool calls with zero file
// mutations." That's a false positive — browser-driven tasks don't
// mutate files, they mutate external systems.
//
// Fix shape: anything that produces a side effect outside the agent's
// process counts. `browser` covers UI automation (clicks, fills,
// navigations). `http_request` covers API calls. The communication tools
// cover messaging. Membership here means "this tool just did something
// observable; the counter resets."
const MUTATION_TOOLS = new Set([
  // File changes
  "write", "edit", "self_edit", "build_app",
  "mcp_filesystem_write_file", "mcp_filesystem_edit_file",
  // Browser-driven UI work (every browser action is potentially side-
  // effecting; reading args to filter would over-fit, just count all)
  "browser",
  // HTTP — non-GET methods are committing per committing-tool-check.ts.
  // We don't have args here to filter by method; counting all http_request
  // calls is the right tradeoff (GETs are also progress in the sense that
  // they ARE happening — model isn't spinning if it's hitting endpoints).
  "http_request",
  // Communication / external sends
  "email_send", "whatsapp_send", "telegram_send", "sms_send",
  // Calendar / contacts mutations
  "calendar_create", "calendar_update", "calendar_delete",
  "contacts_create", "contacts_update", "contacts_delete",
  // Vault / secrets writes
  "secret_save", "secret_delete",
  "browser_capture_to_secret", "browser_fill_from_secret",
  // Sidebar / UI state
  "sidebar_pin", "sidebar_unpin",
  // Memory writes
  "memory_save", "memory_update_profile",
  // Cron / scheduling mutations
  "cron_create", "cron_delete", "cron_update",
  // Delegation (spawning a worker IS the action)
  "agent_spawn", "delegate", "op_submit", "op_submit_async",
  "operation_start",
]);

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
      logRetry({ kind: "loop-abort", tool: toolCalls[0]?.name, detail: { repeatLimit, modelTier: opts?.modelTier } });
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
  //
  // Progress tools (write/edit/bash/build_app/self_edit) RESET the spiralable
  // counts because they prove the agent is doing work, not spinning. The
  // common audit-then-edit-then-verify-then-edit pattern would otherwise
  // accumulate reads across all phases and falsely trip the gate during
  // legitimate multi-step work on a large file.
  const PROGRESS_TOOLS = new Set([
    "write", "edit", "bash", "build_app", "self_edit",
    "task_create", "task_update",
    "op_submit", "op_submit_async",
    "memory_save", "memory_update_profile",
  ]);
  const SPIRALABLE_TOOLS = new Set([
    "glob", "web_search", "read", "grep",
    "agent_whoami", "agent_team_list", "issue_list", "issue_search",
    "memory_search", "memory_recall", "memory_get",
    "task_list", "operation_status", "operation_list",
    // Worker-pool status checks loop just like the legacy operation_status —
    // chat agent kept polling op_status 16x in one turn waiting for a long
    // op to finish. Treat as spiralable so the discovery-limit guard fires.
    "op_status", "op_wait", "agent_status", "agent_output",
  ]);
  let madeProgress = false;
  let madeMutation = false;
  for (const tc of toolCalls) {
    if (PROGRESS_TOOLS.has(tc.name)) madeProgress = true;
    if (MUTATION_TOOLS.has(tc.name)) madeMutation = true;
    state.toolNameCounts.set(tc.name, (state.toolNameCounts.get(tc.name) || 0) + 1);
  }
  if (madeProgress) {
    // Reset only the spiralable counters — progress was made, the prior
    // reads were useful scaffolding, not a spiral. Keep non-spiralable
    // counts intact (they don't gate anything anyway).
    for (const name of SPIRALABLE_TOOLS) state.toolNameCounts.delete(name);
  }
  // No-progress detector: count iterations since the last mutating call.
  // Mutations reset to 0; everything else (bash, read, grep, git status) ticks.
  // When the counter exceeds NO_PROGRESS_LIMIT, abort the turn — the agent is
  // either done (and stalling) or stuck (and spinning).
  if (madeMutation) {
    state.iterationsSinceMutation = 0;
  } else {
    state.iterationsSinceMutation++;
    const noProgLimit = isWeakOrMedium ? NO_PROGRESS_LIMIT_WEAK : NO_PROGRESS_LIMIT;
    if (state.iterationsSinceMutation >= noProgLimit) {
      logRetry({ kind: "loop-abort", tool: "no-progress", detail: { iterations: state.iterationsSinceMutation, limit: noProgLimit, modelTier: opts?.modelTier } });
      // Reset so the next turn starts clean if the parent loop ignores the abort.
      state.iterationsSinceMutation = 0;
      return {
        abort: true,
        nudge: `\n\n(No-progress abort: ${noProgLimit}+ iterations of tool calls with zero file mutations. Your work is either done or stuck. End the turn now.)`,
      };
    }
  }
  const stuck = [...state.toolNameCounts.entries()].find(([name, count]) =>
    count >= discoveryLimit && SPIRALABLE_TOOLS.has(name)
  );
  if (stuck) {
    const [toolName, count] = stuck;
    state.toolNameCounts.set(toolName, 0);
    // Pivot-toward-action nudge, not a dead-end "STOP." The model usually
    // has enough context by call N — what it needs is permission to switch
    // tactics, not an instruction to give up. Mention the natural next
    // action so weak models don't flounder picking the next tool.
    const pivotHint = (toolName === "read" || toolName === "glob" || toolName === "grep")
      ? " You have enough context — switch tactic: use write/edit/bash to act on what you've already read, or ask the user a focused question if you're truly stuck."
      : " You have enough context — produce the answer or take the next concrete action.";
    return {
      abort: false,
      nudge: `SYSTEM: ${toolName} called ${count} times this turn — that's a discovery loop signal.${pivotHint} Do not call ${toolName} again unless you have a specific new file/path/term to look up.`,
    };
  }

  return { abort: false, nudge: null };
}

// ── Post-commit nudge ──
//
// Today's failure mode: build_app worker committed at iteration N, then
// continued running for 5 more minutes / 100+ iterations because the
// perma-fix mandate kept it expanding scope ("now wire it into settings UI
// too..."). A successful git commit is a strong signal the user-facing work
// is DONE for this turn — anything more should be a follow-up turn.
//
// Pattern: scan tool results for `bash`-style outputs with git's commit
// success signatures. If found, set state.postCommitNudgePending. The next
// iteration's prompt-layer code reads the flag and injects a wrap-up nudge.

// Git commit success patterns. Examples:
//   "[main abc1234] commit message"
//   "[feature/x f0e1d2c] msg"
//   " 12 files changed, 345 insertions(+), 67 deletions(-)"
const GIT_COMMIT_OUTPUT_RE = /\[[\w/-]+\s+[a-f0-9]{7,40}\]|\d+\s+files?\s+changed/;

export function checkPostCommit(
  toolResults: Array<{ name: string; result: string }>,
  state: LoopState,
): { nudge: string | null } {
  // First: if a PREVIOUS iteration set the flag, emit the nudge now and clear
  // it. The nudge fires on the iteration AFTER the commit so the agent has a
  // chance to see its commit landed before being told to wrap up.
  let nudge: string | null = null;
  if (state.postCommitNudgePending) {
    state.postCommitNudgePending = false;
    nudge =
      "\n\n(Post-commit nudge: a git commit just landed. Unless the user explicitly asked for additional work in THIS turn, end the turn now with a one-sentence summary of what shipped — further integration is a follow-up task.)";
  }
  // Then: detect a fresh commit in THIS iteration's results and set the flag
  // for the next iteration to see. (Order matters — this must run AFTER the
  // pending-check so a commit detected this iteration doesn't immediately
  // get cleared.)
  for (const r of toolResults) {
    if (r.name !== "bash" && r.name !== "shell") continue;
    if (GIT_COMMIT_OUTPUT_RE.test(r.result)) {
      state.postCommitNudgePending = true;
      break;
    }
  }
  return { nudge };
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

// "0 results" patterns owned by src/errors/classifier.ts. Progress-style
// empty stays here because it's specific to long-running search ops, not
// a general error pattern.
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
  // EMPTY_RESULT_RE moved to src/errors/classifier.ts (single owner).
  // Loaded synchronously via require equivalent — top-level static
  // import below would create a cycle if errors/ ever imports this file.
  // Use the dedicated isEmptyResultText helper.
  const isEmpty =
    head.trim().length === 0 ||
    isEmptyResultText(head) ||
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
