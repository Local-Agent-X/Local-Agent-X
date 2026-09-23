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
