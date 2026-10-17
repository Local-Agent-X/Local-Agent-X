// Canonical: the ONE per-family mapping from a create-class tool call to the
// resolved output path it will write. Two importers, one mapping:
// run-sandboxed.ts (task-artifact pre-stat) and audit-tool-call.ts
// (provenance recording) — extend it HERE, never fork a second
// tool→target-key table.

import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { declaredPaths, pathSpecsForCall, TOOL_PATH_ARGS } from "../tool-registry.js";
import { chartOutPath } from "../tools/chart-tools.js";
import { addSlideOutPath } from "../tools/presentation-tools.js";

// Create-class tools — a SUCCESSFUL call means "a persistent file now exists
// at a caller-named path": every tool whose policy row declares a `write`
// path spec. Cheap membership gate: every other tool skips the task-artifact
// pre-stat entirely (that phase is on EVERY tool call). Membership is
// (tool, action)-conditional in createTargetPath below, by the same specs.
export const CREATE_CLASS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_PATH_ARGS).filter(([, specs]) => specs.some((spec) => spec.action === "write")).map(([name]) => name),
);

// The resolved output path a create-class call will write, or null when this
// (tool, action, args) combination creates nothing (e.g. spreadsheet read):
// the path the call's `write` spec names (the office families' specs are
// action-scoped, so a read action names none).
// PARITY RULE: resolve each tool's path EXACTLY as that tool's execute does —
// with sessionIdOf(args), the session the resolve phase stamps on every
// path-gated tool, so a registered session work root (auto-build chunk
// workers) anchors relative paths here as it does in the tool. A sessionless
// resolve enrolled a never-created workspace spelling and missed the real
// artifact. Two tools derive their output from the named path rather than
// writing it: create_chart (".png" appended) and presentation add_slide
// (`_slide_N.pptx` beside the original) — their exported derivations are the
// SAME functions the execute bodies call, so pre-stat and write land on one
// path. A presentation `edit` names no new file and creates nothing.
export function createTargetPath(toolName: string, args: Record<string, unknown>): string | null {
  const action = typeof args.action === "string" ? args.action : "";
  const sessionId = sessionIdOf(args);
  if (toolName === "create_chart") {
    return typeof args.file_path === "string" && args.file_path ? chartOutPath(args.file_path, sessionId) : null;
  }
  if (toolName === "presentation") {
    if (action === "edit") return null;
    if (action === "add_slide") {
      if (typeof args.file_path !== "string" || !args.file_path) return null;
      try { return addSlideOutPath(resolveAgentPath(args.file_path, sessionId), args.position); } catch { return null; }
    }
  }
  const spec = pathSpecsForCall(toolName, args).find((s) => s.action === "write");
  const raw = spec ? (declaredPaths(args, spec) ?? [])[0] : undefined;
  if (typeof raw !== "string" || !raw) return null;
  try { return resolveAgentPath(raw, sessionId); } catch { return null; }
}
