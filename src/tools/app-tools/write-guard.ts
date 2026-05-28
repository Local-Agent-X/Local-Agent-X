/**
 * Write-time enforcement for files written under workspace/apps/<id>/. Pure
 * text checks — no fs ops. The build agent learns about these constraints
 * up front via AGENTS.md and the per-build env briefing; the guard exists
 * so violations get rejected inside the same turn rather than surfacing
 * as a silent CSP refusal three turns later.
 *
 * Only fires on files under workspace/apps/. Code outside the app folder
 * (the rest of the repo) isn't sandboxed and isn't this guard's concern.
 */

export interface WriteGuardResult {
  allow: boolean;
  reason?: string;
}

const BLOCKED_CDNS = [
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

// Tiny snippets (partial edits, single-line tweaks) shouldn't trip the
// viewport-meta requirement — html files are routinely edited in slivers.
const VIEWPORT_CHECK_MIN_BYTES = 200;

function isUnderAppsDir(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/workspace/apps/");
}

function isHtml(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

export function checkAppWrite(filePath: string, content: string): WriteGuardResult {
  if (!isUnderAppsDir(filePath)) return { allow: true };

  for (const host of BLOCKED_CDNS) {
    if (content.includes(host)) {
      return {
        allow: false,
        reason: `references blocked CDN host '${host}'`,
      };
    }
  }

  if (isHtml(filePath) && content.length >= VIEWPORT_CHECK_MIN_BYTES) {
    if (!/<meta[^>]+name=["']viewport["']/i.test(content)) {
      return {
        allow: false,
        reason: "html missing <meta name=\"viewport\"> (required for mobile-correct rendering)",
      };
    }
  }

  return { allow: true };
}

/** Convenience: render the rejection-message line the tools emit on block. */
export function writeGuardRejectionMessage(reason: string): string {
  return `Write rejected: ${reason}. The preview iframe blocks external CDNs (see AGENTS.md). Inline or self-host.`;
}
