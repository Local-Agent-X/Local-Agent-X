// Lightweight evidence model: count tool calls that look like they
// advanced the agent's understanding or the world's state. The diff of
// this count across turns drives mid-turn-stale / detectEvidenceStale —
// flat for 3 turns => "you're spinning."
//
// Default-include policy: any tool that exists in tool-registry counts
// as evidence. The prior hand-maintained allowlist drifted — it included
// `read`/`bash`/`grep`/`browser`/etc. but NOT `tool_search`, agent_list,
// agency_create, issue_*, task_*, or any orchestration primitive. So the
// safety brake mis-fired during normal tool discovery (Nutrishop demo,
// 2026-05-27): the agent searched for the right tool across 4 turns, the
// counter never moved, the first-strike nudge fired prematurely.
//
// Single source of truth: tool-registry.ts. Adding a tool there auto-
// enrolls it as evidence. The denylist below covers the only tools that
// genuinely don't represent progress when called.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { TOOLS } from "../tool-registry.js";

/** Tools that don't count as evidence even when called successfully:
 *  plan-mode toggles, pure UI flips, self-inspection. Calling them
 *  doesn't move the work forward, so they shouldn't reset the stall
 *  counter. */
const NON_EVIDENCE_TOOLS: ReadonlySet<string> = new Set<string>([
  "enter_plan_mode",
  "exit_plan_mode",
  "session_status",
  "voice_visual",
  "agent_whoami",
  "config_get",
]);

/**
 * Scan turn messages for evidence-generating tool calls. Returns a count.
 * Caller diffs this across iterations to detect staleness.
 */
export function computeEvidenceCount(messages: ChatCompletionMessageParam[]): number {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      const name = tc.function?.name || "";
      if (!name) continue;
      if (NON_EVIDENCE_TOOLS.has(name)) continue;
      if (!TOOLS[name]) continue;  // unregistered name — skip, conservative
      count += 1;
    }
  }
  return count;
}
