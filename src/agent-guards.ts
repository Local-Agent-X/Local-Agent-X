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
// Pattern 3: Completion announcements ("Done." "Done — X scheduled" "✓ Created")
// followed by an action word — model declares success without proof.
const CREATION_HALLUCINATION_RE_3 = new RegExp(
  "^\\s*(Done|All set|Complete|Finished|Confirmed|✓|✅)\\b[\\s\\S]{0,120}(scheduled|created|saved|added|updated|built|deployed)\\b",
  "i"
);
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
    CREATION_HALLUCINATION_RE_3.test(text) ||
    TOOL_ID_HALLUCINATION_RE.test(text)
  ) {
    return "You claimed to have added/updated/created/scheduled something but you did NOT actually call a tool. The change did NOT happen. Do NOT invent IDs. Call the actual tool now (mission_schedule_create with name/schedule/prompt for new missions, mission_schedule_update for edits, write for files, etc).";
  }
  return null;
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

/**
 * Check for exact-repeat loops (same call 3x) and discovery loops (same tool 8+ times).
 * Returns a nudge message if a loop is detected, or null.
 */
export function checkToolLoops(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
): { abort: boolean; nudge: string | null } {
  // Exact-repeat detection (3x same call)
  const key = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join("|");
  if (key === state.lastToolKey) {
    state.sameToolCount++;
    if (state.sameToolCount >= 3) {
      return { abort: true, nudge: "\n\n(Detected repeated tool calls — stopping loop)" };
    }
  } else {
    state.sameToolCount = 1;
    state.lastToolKey = key;
  }

  // Discovery loop detection (same tool called 8+ times)
  for (const tc of toolCalls) {
    state.toolNameCounts.set(tc.name, (state.toolNameCounts.get(tc.name) || 0) + 1);
  }
  const stuck = [...state.toolNameCounts.entries()].find(([name, count]) =>
    count >= DISCOVERY_LOOP_THRESHOLD && ["glob", "web_search", "read", "bash"].includes(name)
  );
  if (stuck) {
    const [toolName, count] = stuck;
    state.toolNameCounts.set(toolName, 0);
    return {
      abort: false,
      nudge: `SYSTEM: You have called ${toolName} ${count} times. Stop searching and produce your final output with the information you already have. Do not make any more ${toolName} calls.`,
    };
  }

  return { abort: false, nudge: null };
}
