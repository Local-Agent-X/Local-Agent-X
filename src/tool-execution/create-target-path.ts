// Canonical: the ONE per-family mapping from a create-class tool call to the
// resolved output path it will write. Two importers, one mapping:
// run-sandboxed.ts (task-artifact pre-stat) and audit-tool-call.ts
// (provenance recording) — extend it HERE, never fork a second
// tool→target-key table.

import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { chartOutPath } from "../tools/chart-tools.js";
import { addSlideOutPath } from "../tools/presentation-tools.js";

// Create-class tools — a SUCCESSFUL call means "a persistent file now exists
// at a caller-named path". Cheap membership gate: every other tool skips the
// task-artifact pre-stat entirely (that phase is on EVERY tool call). Registry
// names, not the pre-collapse per-action defs: the office families register as
// ONE collapsed tool with an `action` arg (collapse-family.ts), so membership
// is (tool, action)-conditional in createTargetPath below.
export const CREATE_CLASS: ReadonlySet<string> = new Set(["write", "spreadsheet", "document", "pdf", "presentation", "create_chart"]);

// The resolved output path a create-class call will write, or null when this
// (tool, action, args) combination creates nothing (e.g. spreadsheet read).
// PARITY RULE: resolve each tool's path EXACTLY as that tool's execute does —
// never unify. `write` resolves WITH sessionIdOf(args) (read-write-tools.ts;
// the resolve phase stamps _sessionId on file tools), so a registered session
// work root (auto-build chunk workers) anchors its relative paths — a
// sessionless resolve here enrolled a never-created project-root spelling and
// missed the real artifact. The office families resolve SESSIONLESS (their
// own resolvePath alias). create_chart and presentation add_slide go through
// their tools' exported derivations (chartOutPath: workspace-anchored, ".png"
// appended; addSlideOutPath: `_slide_N.pptx` beside the original) — the SAME
// functions the execute bodies call, so pre-stat and write land on one path.
export function createTargetPath(toolName: string, args: Record<string, unknown>): string | null {
  const action = typeof args.action === "string" ? args.action : "";
  let raw: unknown;
  switch (toolName) {
    case "write":
      if (typeof args.path !== "string" || !args.path) return null;
      try { return resolveAgentPath(args.path, sessionIdOf(args)); } catch { return null; }
    case "spreadsheet": if (action === "write") raw = args.file_path; break;
    case "document": raw = action === "create" ? args.file_path : action === "template" ? args.output_path : undefined; break;
    case "pdf": raw = action === "create" ? args.file_path : action === "merge" ? args.output_path : undefined; break;
    case "presentation":
      if (action === "create" || action === "from_outline") raw = args.file_path;
      else if (action === "add_slide" && typeof args.file_path === "string" && args.file_path) {
        try { return addSlideOutPath(resolveAgentPath(args.file_path), args.position); } catch { return null; }
      }
      break;
    case "create_chart":
      return typeof args.file_path === "string" && args.file_path ? chartOutPath(args.file_path) : null;
  }
  if (typeof raw !== "string" || !raw) return null;
  try { return resolveAgentPath(raw); } catch { return null; }
}
