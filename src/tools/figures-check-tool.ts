/**
 * figures_check: the figures check the user asks for. A finished deliverable
 * built from outside figures is checked on its own, a share sized to it, and
 * its note says how much ("Checked 16 of 40 figures … Ask me to check the
 * rest"). This tool is the asking: the rest of a file's figures, or every one
 * of them when the user wanted each slide fact-checked from the start (owner's
 * call, 2026-11-24). It waits for the result, corrections included, and the
 * note on the reply says what was found.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { readOp } from "../ops/op-store.js";
import { checkFiguresOnRequest } from "../canonical-loop/public/verification-pass.js";
import { operationIdOf, sessionIdOf } from "../tool-execution/internal-args.js";
import { resolveAgentPath } from "../workspace/paths.js";

const RESULT_TEXT: Record<string, string> = {
  off: "The figures check is turned off in Settings (verify deliverables), so nothing was checked. Tell the user.",
  "no-files": "None of those files exists, so nothing was checked.",
  busy: "A figures check is already running in this chat. Its result lands on the reply's note; try again once it has.",
  "not-submitted": "The check could not start (no model was available to run it). Tell the user the figures were not checked.",
};

export const figuresCheckTool: ToolDefinition = {
  name: "figures_check",
  description:
    "Check a deliverable's figures (deck, document, markdown, CSV) against independent sources, and correct any that do not match. " +
    "A finished deliverable built from web figures is already checked on its own, a share sized to it, and its note says how many " +
    "(\"Checked 16 of 40 figures\"). Call this when the user asks to check the rest (scope \"rest\"), or when they asked for every figure " +
    "or every slide to be fact-checked (scope \"all\"; call it right after you save the file, before you finish). It waits for the " +
    "result, which can take minutes for a long deck, and returns what the check found.",
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "The deliverable files to check." },
      scope: { type: "string", enum: ["rest", "all"], description: "rest: every figure not yet confirmed. all: every figure, again." },
    },
    required: ["paths", "scope"],
  },
  async execute(args, signal): Promise<ToolResult> {
    const sessionId = sessionIdOf(args);
    const opId = operationIdOf(args);
    const op = opId ? readOp(opId) : null;
    if (!sessionId || !op) return { content: "figures_check runs inside a chat request and needs one.", isError: true };
    const raw = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p.trim() !== "") : [];
    if (raw.length === 0) return { content: "Name the file or files to check in `paths`.", isError: true };
    const scope = args.scope === "all" ? "all" : "rest";
    const { result, note } = await checkFiguresOnRequest(op, raw.map((p) => resolveAgentPath(p, sessionId)), scope, signal);
    if (result === "checked") return { content: note ?? "The check finished." };
    if (result === "timed-out") return { content: `${note ?? "The check is still running."} It is still running; its result lands on the reply's note when it finishes.` };
    return { content: RESULT_TEXT[result], ...(result === "not-submitted" ? { isError: true } : {}) };
  },
};
