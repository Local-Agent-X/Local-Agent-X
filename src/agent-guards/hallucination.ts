// Approval and creation hallucination detection. Two distinct nudges:
//
//   - Approval: model asks for permission ("requires approval") when it
//     should just call the tool. Push back with "you have full permission".
//
//   - Creation: model claims to have added/saved/scheduled X without
//     calling a tool, or invents a tool-ID-looking string ("Job ID:
//     5a0fb8ae") that no tool ever returned. Push back with "the change
//     did NOT happen — call the actual tool".
//
// Both run on assistant text only. Code blocks are stripped first
// (see code-strip.ts) so prompts and quoted samples don't trigger.

import { stripCodeBlocks } from "./code-strip.js";

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
