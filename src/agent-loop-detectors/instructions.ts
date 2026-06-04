// Retry instructions injected into the next attempt's system context.
// Kept as named exports so callers can also use them for telemetry/audit.

export const PLANNING_ONLY_INSTRUCTION =
  "Your previous reply described a plan but did not call any tools. Do not restate the plan. Take the first concrete tool action now. If a real blocker prevents action, state the exact blocker in one sentence.";

export const SINGLE_ACTION_STOP_INSTRUCTION =
  "Your previous reply ran one exploratory tool (read/list/search/glob) and implied more work would follow, but then stopped. Continue now with the next concrete action — save the file, call the write/edit tool, whatever the next step is. Do not re-explore. Do not summarize. Act.";

export const REASONING_ONLY_INSTRUCTION =
  "Your previous attempt recorded reasoning but did not produce a user-visible reply. Continue from the partial state and produce the visible answer now. Do not restart from scratch.";

export const EMPTY_RESPONSE_INSTRUCTION =
  "Your previous attempt produced no visible reply and no tool calls. Continue from current state and produce a visible answer or take the next concrete tool action.";

export const UNCOMMITTED_TURN_INSTRUCTION =
  "You called tools but none of them committed the change the user asked for. Call the tool that actually commits work now (write/edit/send/save/pin/deploy — whichever matches the request). Exploration is done.";

export const EVIDENCE_STALE_INSTRUCTION =
  "You have been reading and searching without new findings for several rounds. Either take a different approach (different tool, different args, different source) or tell the user the exact blocker in one sentence. Do not repeat the same queries.";

export const INCOMPLETE_MULTISTEP_INSTRUCTION =
  "The user asked for several steps and you stopped after completing only one. Continue now with the next step. Write your per-step summary exactly as the user asked for it, then immediately proceed to the following step yourself — do not hand control back until every numbered step and any final report are done.";
