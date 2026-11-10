/**
 * `work_note` — tell the other agents working in this project what you
 * changed and why, and optionally claim an area before you start on it
 * (ADR 0007 §1, §3). The note reaches them at the start of their next turn and
 * at the moment they are about to write a file you are changing.
 */
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { operationIdOf, sessionIdOf } from "../tool-execution/internal-args.js";
import { resolveAgentPath, sessionWorkRootOf } from "../workspace/paths.js";
import { locateInRepo } from "./repo-locate.js";
import { holdersOfSession, liveHolders, recordClaims } from "./work-claims.js";
import { postNote, NOTE_TEXT_MAX } from "./handover-notes.js";

function err(content: string): ToolResult { return { content, isError: true }; }

/** The repos the note is about, with the paths in each. */
function placesFor(sessionId: string, paths: string[]): Map<string, string[]> {
  const workRoot = sessionWorkRootOf(sessionId);
  const out = new Map<string, string[]>();
  for (const raw of paths) {
    const place = locateInRepo(resolveAgentPath(raw, sessionId), workRoot);
    if (place) out.set(place.repoKey, [...(out.get(place.repoKey) ?? []), place.rel]);
  }
  if (out.size > 0 || paths.length > 0) return out;
  for (const h of holdersOfSession(sessionId)) out.set(h.repoKey, []);
  if (out.size === 0 && workRoot) {
    const place = locateInRepo(join(workRoot, ".work-note"), workRoot);
    if (place) out.set(place.repoKey, []);
  }
  return out;
}

export const workNoteTool: ToolDefinition = {
  name: "work_note",
  description:
    "Tell the other agents working in this project (other chats, workers, sub-agents) what you changed and why, "
    + "or what you are about to rework. They read it at the start of their next turn and when they are about to "
    + "write a file you are changing. Set claim=true to claim the files or folders in `paths` before you start, "
    + "so anyone writing there is told who is working on it.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: `What you changed or are changing, and why. One or two sentences, at most ${NOTE_TEXT_MAX} characters.` },
      paths: { type: "array", items: { type: "string" }, description: "Files or folders the note is about, relative to your work folder or absolute." },
      claim: { type: "boolean", description: "Also claim `paths` as your area of work (default false)." },
    },
    required: ["text"],
  },
  async execute(args) {
    const sessionId = sessionIdOf(args);
    if (!sessionId) return err("work_note needs a session.");
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return err("text is required.");
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p.trim() !== "") : [];
    if (args.claim === true && paths.length === 0) return err("claim=true needs the files or folders to claim in `paths`.");
    const places = placesFor(sessionId, paths);
    if (places.size === 0) return err("These paths are in no project: name files inside your work folder or a git repo.");
    const opId = operationIdOf(args);
    if (args.claim === true) {
      recordClaims({ sessionId, opId, paths: paths.map((p) => resolveAgentPath(p, sessionId)), source: "declared", fallbackRoot: sessionWorkRootOf(sessionId) });
    }
    let readers = 0;
    for (const [repoKey, rels] of places) {
      const mine = holdersOfSession(sessionId).find((h) => h.repoKey === repoKey);
      postNote({ sessionId, displayName: mine?.displayName ?? sessionId, repoKey, paths: rels, text, kind: "agent" });
      readers += liveHolders(repoKey).filter((h) => h.sessionId !== sessionId).length;
    }
    const claimed = args.claim === true ? ` Claimed: ${paths.join(", ")}.` : "";
    return { content: `Note posted. ${readers === 0 ? "No other agent is working in this project right now; any that start will see it." : `${readers} other agent(s) working in this project will see it.`}${claimed}` };
  },
};
