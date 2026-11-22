/**
 * Keys in what a publish would ship. A push or a deploy is where a file's
 * content leaves the machine for good: a repository's history and a public
 * site cannot be taken back. So this is where text that looks like a password
 * or an access key is put to the user, not when the file is saved (see
 * tools/read-write-tools.ts for why not there).
 *
 * The publish gate (publish-review-gate.ts) adds these to the model's review
 * as RED findings, and RED's own path does the rest: the finding goes back to
 * the agent first (to take the key out, or to publish again unchanged if it is
 * not one), and a disputed one reaches the user as a "Push anyway" card that
 * names the file, the line and what the text is attached to. An unattended
 * publish is blocked.
 *
 * Only added lines are judged: what the remote already holds was published
 * before. The judgement is the canonical scanner's (security/secrets), the
 * same one that guards a web request.
 */
import { isSecretScannedFile, scanForSecrets, secretMatchPhrase } from "../security/secrets/index.js";
import type { ChangeSet, ChangeSetPart, FileDiff } from "../publish-review/change-set-types.js";
import type { PublishReview, ReviewFinding } from "../canonical-loop/public/publish-review.js";

/** A card stays readable: the first few are named, the rest counted. */
const MAX_KEY_FINDINGS = 5;

interface AddedLines {
  /** The added lines, joined by newlines. */
  text: string;
  /** For each line of `text`, its line number in the new file. */
  lineNumbers: number[];
}

/** The lines a unified diff adds, with the line each has in the new file. */
export function addedLinesOf(diff: string): AddedLines {
  const lines: string[] = [];
  const lineNumbers: number[] = [];
  let next = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { next = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) { lines.push(line.slice(1)); lineNumbers.push(next++); }
    else if (line.startsWith(" ") || line === "") next++; // context; a blank one may have lost its space
    else if (!line.startsWith("-") && !line.startsWith("\\")) inHunk = false; // the next file's header
  }
  return { text: lines.join("\n"), lineNumbers };
}

function findingsIn(part: ChangeSetPart, file: FileDiff): ReviewFinding[] {
  if (!isSecretScannedFile(file.path)) return [];
  const added = addedLinesOf(file.text);
  if (!added.text) return [];
  const where = part.kind === "git-push" ? "repository" : "site or package";
  // One finding per line: a key often matches twice (its own shape, and the
  // `name = value` around it), and the person is asked about the line once.
  const seenLines = new Set<number>();
  return scanForSecrets(added.text).matches.flatMap((match): ReviewFinding[] => {
    const line = added.lineNumbers[added.text.slice(0, match.startIndex).split("\n").length - 1];
    if (seenLines.has(line)) return [];
    seenLines.add(line);
    return [{
      severity: "red",
      location: `${file.path}:${line}`,
      problem: `This would publish ${secretMatchPhrase(added.text, match, "here")}, which could be a password or access key.`,
      why: `Once it is in a ${where} others can read, it cannot be taken back; a real key would have to be replaced.`,
      fix: "If it is a real key: take it out of the file (keep it in Settings → Secrets or an environment variable) and replace the key. " +
        "If it is not a secret (a public identifier, sample data), publish again unchanged and the user decides.",
    }];
  });
}

/** Every key-shaped text the change set adds, as review findings. */
export function keyFindings(changeSet: ChangeSet): ReviewFinding[] {
  const all = changeSet.parts.flatMap((part) => part.fileDiffs.flatMap((file) => findingsIn(part, file)));
  if (all.length <= MAX_KEY_FINDINGS) return all;
  const shown = all.slice(0, MAX_KEY_FINDINGS);
  const last = shown[MAX_KEY_FINDINGS - 1];
  shown[MAX_KEY_FINDINGS - 1] = { ...last, problem: `${last.problem} (And ${all.length - MAX_KEY_FINDINGS} more like it in this change.)` };
  return shown;
}

/** The review with the change set's key findings in front, RED when there are
 *  any: nothing key-shaped ships on a GREEN, and a review that could not run
 *  does not wave one through. */
export function withKeyFindings(review: PublishReview, changeSet: ChangeSet): PublishReview {
  const found = keyFindings(changeSet);
  if (found.length === 0) return review;
  return { ...review, status: "RED", findings: [...found, ...review.findings] };
}
