/**
 * What the orchestrator chat is told at the start of each turn (ADR 0007 §7):
 * that it holds the role, who is working in the project and where they
 * overlap, how to hand work out (one worker per task, each in its own copy,
 * with its area and its model named), the user's model preferences, the rules
 * it decides coordination questions by, and what is never its call.
 *
 * Joined ahead of the "other agents" section (other-agents-block.ts), which
 * still carries the new hand-over notes.
 */
import { basename } from "node:path";
import { rolesOf } from "./orchestrator-role.js";
import { liveHolders, type HolderView } from "./work-claims.js";
import { normRepoPath, repoPathsOverlap } from "./path-overlap.js";

function overlaps(a: HolderView, b: HolderView): boolean {
  return a.claims.some((x) => b.claims.some((y) => repoPathsOverlap(normRepoPath(x.path), normRepoPath(y.path))));
}

const STATE: Record<string, string> = { active: "working now", idle: "between messages", recent: "lately" };

function agentLines(sessionId: string, repoKey: string, areasOf: (h: HolderView) => string[]): string[] {
  const all = liveHolders(repoKey).filter((h) => h.sessionId !== sessionId);
  if (all.length === 0) return ["Nobody else is working in this project right now."];
  return all.map((h) => {
    const clash = all.filter((o) => o !== h && o.state !== "recent" && overlaps(h, o)).map((o) => o.displayName);
    const areas = areasOf(h);
    return `- ${h.displayName} (${h.kind}, ${STATE[h.state] ?? h.state}, in ${basename(h.checkout)})${h.task ? `: ${h.task}` : ""}`
      + `${areas.length ? ` — changing ${areas.join(", ")}` : ""}${clash.length ? ` — OVERLAPS ${clash.join(", ")}` : ""}`;
  });
}

/** The orchestrator's brief for `sessionId`, or "" when it holds no role. */
export function orchestratorBrief(sessionId: string, areasOf: (h: HolderView) => string[]): string {
  const roles = rolesOf(sessionId);
  if (roles.length === 0) return "";
  const out: string[] = ["--- ORCHESTRATOR ---",
    "The user made this chat the orchestrator of this project: you hand work to other agents and settle who works where, so the user is not asked each time."];
  for (const role of roles) {
    out.push("Working in the project now:", ...agentLines(sessionId, role.repoKey, areasOf));
    out.push(role.routing
      ? `The user's model preferences (follow them when you pick a model for a task): ${role.routing}`
      : "The user gave no model preferences: leave `model` off a task unless they name one.");
  }
  out.push(
    "Handing out work:",
    "- Split a goal into tasks that do not change the same files. Start each with agent_spawn: `work_dir` is the project folder (the worker then gets its own copy and merges back when it finishes), `touches` is the files or folders it will change, `model` is the model for that task.",
    "- Never run two workers whose `touches` overlap at the same time; run those one after the other.",
    "- A chat already working here has the context for its own area: hand it a task with work_assign (its name, and the task written out in full). Find work_assign with tool_search if it is not among your tools.",
    "The app messages you when something here needs settling (two agents in the same files, a merge that landed on someone's work, a worker that stopped, a task you handed out that finished). Those messages are the app's, not the user's.",
    "The rules you decide by, in this order:",
    "1. Two agents never write one folder. A chat that opens on a folder another chat is writing is moved to its own copy before it writes; you do not need to act.",
    "2. When two branches change the same files, the smaller change merges first; tell the other agent to merge the base branch into its own before it lands.",
    "3. When two agents claim one area for different goals, pause the later one (agent_pause) and tell both why (work_note).",
    "Post every decision with work_note, so the user can read what you decided and why.",
    "Never yours to decide: approving a risky action for another agent, anything about secrets or money, product or taste choices. Those go to the user.",
    "--- END ORCHESTRATOR ---",
  );
  return out.join("\n");
}
