// Active failure-correction layer. When tools in a turn return non-ok
// statuses, the model often emits a confident "done!" message because it
// either didn't process the tool_result properly or wants to escape the
// loop. We inject a synthetic user-role nudge into turn+1 and force the
// drive loop to continue (override terminalReason "done" → null) so the
// model has to address the failure on the next turn instead of gaslighting
// the user. Real failure (2026-05-23, repeating-text): grok-code-fast-1
// said "fixed it" while two `edit` calls hit `old_string found 2 times`
// and never wrote a byte.
//
// Why not a UI banner: the banner sits in the assistant message AFTER the
// turn — it tells the user but does nothing to fix the model's behavior.
// The nudge forces the model to either retry the failed call with the
// recovery hint it was given, or honestly admit it can't.
//
// Loop safety: the existing per-op turn cap in worker.ts terminates the
// drive loop regardless of nudges, so an unfixable failure can't spiral.

import type { CommitTurnMessage } from "../checkpoint.js";
import { parseStatusHeader } from "../../tools/result-helpers.js";
import { extractToolResultText } from "./content-extract.js";
import { MUTATION_TOOLS } from "../../agent-guards/loop-detection.js";

type ToolSummaryEntry = { tool: string; toolCallId?: string };

export interface ToolFailureSummary {
  failures: { tool: string; reason: string }[];
  /**
   * True when at least one mutation tool (write / edit / build_app / browser
   * action / http_request / etc — see MUTATION_TOOLS) succeeded in this
   * turn. Means the model actually changed something on disk or in the
   * outside world. Used to suppress the gaslighting nudge in the mixed
   * case where the model had failures earlier but ultimately landed a real
   * change — that's not gaslighting, that's iteration. Real failure 2026-
   * 05-23: repeating-text turn had 4 edit failures + 1 successful write
   * (the actual fix). My v1 nudge fired on the failures alone and forced
   * an extra turn that regurgitated the same response, surfacing as a
   * "chat printed response twice" UX bug.
   */
  hadSuccessfulMutation: boolean;
}

export function collectToolFailures(
  toolMessages: CommitTurnMessage[],
  toolSummary: ToolSummaryEntry[],
): ToolFailureSummary {
  const failures: { tool: string; reason: string }[] = [];
  let hadSuccessfulMutation = false;
  for (let i = 0; i < toolMessages.length; i++) {
    const text = extractToolResultText(toolMessages[i].content);
    const status = parseStatusHeader(text);
    const toolName = toolSummary[i]?.tool ?? "unknown";
    if (status === "ok") {
      if (MUTATION_TOOLS.has(toolName)) hadSuccessfulMutation = true;
      continue;
    }
    if (status === "running") continue;
    // Strip the rendered status header + collapse multi-line content so the
    // nudge stays short; full failure is still in the tool_result row.
    const firstLine = text.replace(/^\[[^\]]*\]\n?/, "").split("\n")[0].slice(0, 200);
    failures.push({ tool: toolName, reason: firstLine });
  }
  return { failures, hadSuccessfulMutation };
}

export function shouldNudgeForFailures(summary: ToolFailureSummary): boolean {
  // Nudge ONLY when there are failures AND no successful mutation. If the
  // model retried and eventually succeeded with a real change, accept its
  // "done" — that's progress, not gaslighting. Read-only successes (read,
  // grep, glob) don't count: a model can spam reads after edit failures
  // and then claim done; nudge still fires there because read isn't in
  // MUTATION_TOOLS.
  return summary.failures.length > 0 && !summary.hadSuccessfulMutation;
}

export function formatFailureNudgeForModel(summary: ToolFailureSummary): string {
  if (summary.failures.length === 0) return "";
  const lines = [
    `[automatic check] ${summary.failures.length} tool ${summary.failures.length === 1 ? "call" : "calls"} in your last turn returned a non-ok status. Do NOT claim the task is done until you've either retried successfully (use the recovery hints already in the tool_result) or honestly reported what's still broken to the user.`,
    "",
    "Failed calls:",
  ];
  for (const f of summary.failures) {
    lines.push(`• ${f.tool} — ${f.reason}`);
  }
  return lines.join("\n");
}
