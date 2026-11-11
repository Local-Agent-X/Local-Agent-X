/**
 * code_handoff — offer to continue a chat's coding work in Code mode.
 *
 * A chat cannot become a code session (a session's mode is fixed at creation),
 * so moving means starting one. When a chat turns into sustained work in a
 * repo, the agent writes a handoff brief into that repo and calls this tool;
 * the user sees a "Continue in Code mode" button under the reply, and clicking
 * it opens a code session on the repo, starting from the brief
 * (routes/sessions-fork.ts). Live 2026-10-25: asked "should we be doing this in
 * code mode?", a chat agent that did not know Code mode existed invented a
 * meaning for it, and the work never moved.
 *
 * It sends nothing and changes nothing: it checks the two paths and puts the
 * offer on the chat (a code_handoff event, shown as a notice). The brief is
 * written beforehand with the ordinary file tools, gated like any write.
 */
import { relative, isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../types.js";
import { err, ok } from "./result-helpers.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { onEventOf, sessionIdOf, toolCallIdOf } from "../tool-execution/internal-args.js";

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

export const codeHandoffTool: ToolDefinition = {
  name: "code_handoff",
  description:
    "Offer to continue this chat's coding work in Code mode, a session bound to one project folder with a coding prompt. " +
    "First write a handoff brief inside the repo (e.g. docs/handoff/<date>-<topic>.md): the goal, the repo path, what is done " +
    "(with commit ids), what is left in order, decisions and why, known bugs, and what needs the user's OK. Then call this with " +
    "the repo folder and the brief. The user gets a \"Continue in Code mode\" button; the new session starts from the brief.",
  parameters: {
    type: "object",
    properties: {
      folder: { type: "string", description: "The repo the work happens in (absolute path)." },
      brief: { type: "string", description: "The handoff brief you wrote, a file inside that folder." },
    },
    required: ["folder", "brief"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = sessionIdOf(args);
    const folder = resolveAgentPath(String(args.folder ?? ""), sessionId);
    const brief = resolveAgentPath(String(args.brief ?? ""), sessionId);
    if (!isDir(folder)) return err(`${folder} is not a folder. Pass the repo the work happens in.`);
    const rel = relative(folder, brief);
    if (rel.startsWith("..") || isAbsolute(rel) || !isFile(brief)) {
      return err(`${brief} is not a file inside ${folder}. Write the brief inside the repo first (e.g. docs/handoff/), then offer it.`);
    }
    onEventOf(args)?.({ type: "code_handoff", toolCallId: toolCallIdOf(args) ?? "", folder, brief: rel.replace(/\\/g, "/") });
    return ok(
      `Offered: a "Continue in Code mode" button is under your reply; it opens a code session on ${folder} starting from ${rel}. ` +
      "Say in a line why Code mode suits this work. The user decides; if they keep going here, keep going here.",
    );
  },
};
