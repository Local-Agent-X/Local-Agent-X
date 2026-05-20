/**
 * Transitional audience tagger (AUDIT Cluster 11, P1.C2).
 *
 * Bridges the current "five drifting Sets" world with the canonical
 * `audiences` field on ToolDefinition. Walks every tool in `allTools`
 * after the registry is built and mutates `tool.audiences` based on
 * Set membership. The legacy Sets stay as the source of truth until
 * P1.C4 when callers migrate; at that point this file is deleted and
 * tools self-declare their audiences at definition site.
 *
 * Why a mutation pass instead of editing every tool source file:
 *   - 60+ tool source files would each need a one-line change.
 *   - The Sets ARE the historical mapping — anything else is a
 *     reinterpretation that could drift.
 *   - This pass is provably equivalent to the current behavior
 *     (filterToolsForMessage still uses the same Sets in P1.C2;
 *     audiences just mirror them).
 *
 * Delete in P1.C4.
 */

import type { Audience, ToolDefinition } from "../types.js";
import { CORE_TOOL_NAMES, BUILD_INTENT_TOOLS } from "./tool-filter.js";

// OPERATOR_TOOLS lives inside a function scope in handler-events.ts.
// Duplicated here for the transition — both copies will die in P1.C4
// when handler-events migrates to resolveToolsForRequest.
const OPERATOR_TOOLS: ReadonlySet<string> = new Set([
  "browser", "bash", "read", "write", "edit", "http_request",
  "web_search", "web_fetch", "view_image", "ocr",
  "memory_search", "memory_save", "memory_recall",
  "document_create", "document_edit", "spreadsheet_read", "spreadsheet_write", "pdf_create",
  "email_send", "setting",
]);

/**
 * Mutate each tool's `audiences` array based on legacy Set membership.
 * Called once at registry build time. Idempotent — re-running produces
 * the same tags.
 */
export function tagToolsByAudience(tools: ToolDefinition[]): void {
  for (const tool of tools) {
    const audiences: Audience[] = [];
    if (CORE_TOOL_NAMES.has(tool.name)) audiences.push("main-chat");
    if (OPERATOR_TOOLS.has(tool.name)) audiences.push("spawned-agent", "operator");
    if (BUILD_INTENT_TOOLS.has(tool.name)) audiences.push("build-intent");
    if (audiences.length > 0) tool.audiences = audiences;
  }
}
