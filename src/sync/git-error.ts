const MAX_STDERR = 2000;

// Git warnings scale with the file count, not the failure count: a catch-up
// `add -A` over ~18k files emits one "LF will be replaced by CRLF" line each,
// megabytes of stderr (2026-07-23 live failure).
const WARNING_LINE = /^\s*(warning|hint):/i;

/**
 * Compress a failed git child into a message fit for the UI/log.
 *
 * Warnings are dropped first. Keeping them was what surfaced 2000 characters
 * of "LF will be replaced by CRLF" as the sync error while the real cause —
 * a 300s timeout kill, whose reason lives in `message`, not stderr — was
 * discarded (2026-09-23 live failure). What git prints on the way to failing
 * is never the failure.
 *
 * What survives is kept from the TAIL: when git itself fails it prints the
 * fatal last.
 */
export function formatGitError(e: { stderr?: string; message: string }, command?: string): string {
  const signal = (e.stderr ?? "")
    .split("\n")
    .filter(line => line.trim() && !WARNING_LINE.test(line))
    .join("\n")
    .trim();
  const detail = signal || e.message;
  const trimmed = detail.length > MAX_STDERR ? `… ${detail.slice(-MAX_STDERR)}` : detail;
  return command ? `git ${command}: ${trimmed}` : trimmed;
}

// ── Why a push failed ────────────────────────────────────────────────────
//
// A push can fail because the remote moved ahead (a real non-fast-forward) or
// because the remote never accepted the credential. Until 2026-09-29 the push
// catch told every failure the first story: "remote has commits this machine
// doesn't have … Hit Force Pull". A rejected token then sent the user to a
// button that runs the same git with the same dead credential and fails
// identically — a next step that cannot work (live failure, this station: a
// PAT expired and the UI reported a divergence three times over, with
// "remote: Invalid username or token" printed inside its own root-cause line).
//
// Auth is checked FIRST because it explains the rebase and merge failures too:
// when the fetch half of a pull cannot authenticate, the divergence is not
// known to have happened at all.

/** How a git remote says "I did not accept this credential". Covers GitHub's
 *  PAT rejection, a credential with no push rights (403 / "Permission … 
 *  denied"), and the shape produced when nothing is supplied at all and
 *  GIT_TERMINAL_PROMPT=0 stops git from asking. */
const AUTH_REJECTION =
  /invalid username or token|authentication failed|could not read username|could not read password|terminal prompts disabled|password authentication is not supported|support for password authentication was removed|403 forbidden|permission to .+ denied|remote: invalid credentials/i;

/** Did any of these git failures come from the remote refusing the credential? */
export function isAuthRejection(...parts: Array<string | undefined>): boolean {
  return parts.some((p) => !!p && AUTH_REJECTION.test(p));
}

/** What the user is told when the token itself is the problem. Names the one
 *  action that can fix it, and rules out the button the old text pointed at. */
export const AUTH_REJECTION_MESSAGE =
  "[sync] the remote rejected this machine's credential — sync cannot push or pull until it is replaced. " +
  "The stored GITHUB_SYNC_TOKEN is expired, revoked, or lacks read/write access to the sync repo. " +
  "Fix it in Settings → Sync by pasting a token with Contents read+write on that repository. " +
  "Force Pull will not help: it runs the same git with the same credential. " +
  "Tokens are per-machine on purpose and never sync, so another machine still working says nothing about this one.";

/**
 * The message for a failed push. `rebaseErr` / `mergeErr` are the two recovery
 * attempts that ran before it, when they ran at all.
 */
export function pushFailureMessage(
  pushErr: string,
  rebaseErr?: string,
  mergeErr?: string,
): string {
  if (isAuthRejection(pushErr, rebaseErr, mergeErr)) {
    return `${AUTH_REJECTION_MESSAGE} Original git error: ${firstLine(pushErr)}`;
  }
  const reasons: string[] = [];
  if (rebaseErr) reasons.push(`rebase failed: ${firstLine(rebaseErr).slice(0, 200)}`);
  if (mergeErr) reasons.push(`merge fallback failed: ${firstLine(mergeErr).slice(0, 200)}`);
  const detail = reasons.length > 0 ? ` (root cause: ${reasons.join("; ")})` : "";
  return `[sync] push rejected — remote has commits this machine doesn't have${detail}. ` +
    `Hit Force Pull to integrate the remote state, then sync again. Original git error: ${firstLine(pushErr)}`;
}

const firstLine = (s: string): string => s.split("\n")[0];
