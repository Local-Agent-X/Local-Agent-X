/**
 * What an approval card says, in the words of the gate that is asking. A
 * card used to open with `Run command: "…"` cut at 150 characters: the user
 * was asked to approve text they could not read, and on a long command the
 * `rm -rf` the card warned about was in the part cut off (2026-10-31). Now:
 *
 *  - A shell ask carries its whole command, and the folder it runs in, as a
 *    typed preview (approval-preview.ts `kind: "shell"`); the card's line is
 *    the reason it is asking, not a second copy of the command.
 *  - An irreversible shell command's line says what it would do in plain
 *    words, read from the same parse the gate used (shell-delete-targets.ts
 *    for a delete: which paths, in which folder). The model that wrote the
 *    command never describes it; a description it wrote could say anything.
 *
 * Both card builders (require-approval.ts for the canonical path,
 * pre-dispatch.ts for the local dispatcher) read this one.
 */
import type { ActionPreview } from "../types.js";
import { previewShellCommand } from "../approval-preview.js";
import { shellCommandOf } from "../tool-registry.js";
import { shellDeletes, type ShellDelete } from "../security/layer/shell-delete-targets.js";
import { deleteLine } from "./delete-prefix.js";
import { shellTreeDeleteScope } from "./tree-delete-scope.js";

/** The destructive reasons that are not deletes (approval-decision.ts
 *  DESTRUCTIVE_COMMAND_PATTERNS), each in plain words. A delete's words come
 *  from its parse instead. */
const PLAIN: Record<string, string> = {
  "git force-push": "Overwrites the branch's history on the remote; commits other people pushed there can be lost",
  "git delete remote branch": "Deletes a branch from the remote repository",
  "git reset --hard": "Throws away every uncommitted change in the repository",
  "git force-delete branch": "Deletes a branch whose commits may exist nowhere else",
  "git history rewrite": "Rewrites the repository's history",
  "dd to a raw device": "Writes raw data straight onto a disk, over whatever is there",
  "filesystem format": "Formats a disk, erasing everything on it",
};

const PROFILE_ASKS = "Your security profile asks before a command like this runs.";
const NAMED_TARGETS = 6;

function list(items: string[]): string {
  const shown = items.slice(0, NAMED_TARGETS).map((t) => `"${t}"`);
  if (items.length > NAMED_TARGETS) shown.push(`${items.length - NAMED_TARGETS} more`);
  return shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function describeDelete(d: ShellDelete): string {
  const names = list(d.targets);
  const where = d.cwd === null ? " in a folder the command changes into" : d.cwd ? ` in ${d.cwd}` : "";
  if (d.verb === "git-clean") return `Deletes every untracked file under ${names}${where}`;
  if (d.verb === "find") return `Deletes the files find selects under ${names}${where}`;
  if (d.opaque) return `Deletes ${names} and whatever its options select${where}`;
  return `Permanently deletes ${names}${where}`;
}

/**
 * What an irreversible call would do, in plain words. A shell delete names
 * its targets and folder; another shell pattern has its sentence above; a
 * destructive tool keeps the reason the gate gave (its describeCall is the
 * card's line).
 */
export function destructiveExplanation(toolName: string, args: Record<string, unknown>, reason: string, cwd?: string): string {
  const command = shellCommandOf(toolName, args);
  if (command === undefined) return reason;
  const plain = PLAIN[reason];
  if (plain) return `${plain}.`;
  const deletes = shellDeletes(deleteLine(command) ?? command, cwd).filter((d) => d.recursive || d.opaque);
  const what = deletes.length > 0 ? deletes.map(describeDelete).join("; ") : `Permanently deletes files (${reason})`;
  return `${what}. Deleted files do not go to the recycle bin.`;
}

export interface CardTextInput {
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
  /** The gate's reason the call is irreversible, or null. */
  destructive: string | null;
  policyReason?: string;
  /** The one-line call description (approval-context.ts). */
  line: string;
  /** A publish ask's review, already rendered (publish-review-text.ts). */
  review?: { context: string; preview: ActionPreview };
}

/** The card's line and, for a shell command, its preview. */
export function approvalCardText(input: CardTextInput): { context: string; preview?: ActionPreview } {
  const { toolName, args, destructive } = input;
  const scope = shellTreeDeleteScope(toolName, args, input.sessionId);
  const explanation = destructive === null ? undefined : destructiveExplanation(toolName, args, destructive, scope?.cwd);
  const headline = (tail: string) =>
    `⚠ Cannot be undone — ${explanation}${explanation === destructive ? "" : ` (${destructive})`} ${tail}`.trim();
  if (input.review) {
    return { context: destructive ? headline(input.review.context) : input.review.context, preview: input.review.preview };
  }
  const command = shellCommandOf(toolName, args);
  const preview = command === undefined ? undefined : previewShellCommand(command, scope?.cwd ?? "", explanation);
  const tail = preview ? "" : input.line;
  if (destructive) return { context: headline(tail), preview };
  if (input.policyReason) return { context: `Policy approval required: ${input.policyReason}. ${tail}`.trim(), preview };
  return { context: preview ? PROFILE_ASKS : input.line, preview };
}
