/**
 * Write-time enforcement for files written under workspace/apps/<id>/. Two
 * concerns, kept independent:
 *   1. Content policy (CDN references, viewport meta) — pure text checks that
 *      apply to EVERY writer of an app file.
 *   2. Baseline lock — when a build's baseline was generated and OWNED by the
 *      harness (frontend-spa scaffold), the model may only add code under src/;
 *      writes/edits to the owned config files (package.json / vite.config /
 *      tsconfig) are rejected so the model can't clobber the working skeleton.
 *
 * The lock is data-driven by a per-app scaffold manifest the harness drops at
 * scaffold time — NOT a global filename rule. An app with no manifest (a
 * full-stack build that legitimately authors its own package.json, a static
 * app, the main chat editing a non-scaffolded app) is untouched. That keeps the
 * two concerns from welding together (see /blast-radius: COUPLED verdict).
 *
 * Only fires on files under workspace/apps/. Code outside the app folder
 * (the rest of the repo) isn't sandboxed and isn't this guard's concern.
 */
import { existsSync, readFileSync } from "node:fs";
import { SCAFFOLD_MANIFEST_REL } from "../framework-scaffold.js";

export interface WriteGuardResult {
  allow: boolean;
  reason?: string;
  /** Full agent-facing rejection message. When set, the tool surfaces it
   *  verbatim instead of the generic CDN-oriented writeGuardRejectionMessage. */
  message?: string;
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

/** Split an app-file path into its `workspace/apps/<id>` root and the app-
 *  relative remainder. null when the path isn't under an app dir. Case-
 *  insensitive on the anchor to match isUnderAppsDir; separators normalized so
 *  Windows paths resolve too. */
function appRootAndRel(filePath: string): { root: string; rel: string } | null {
  const norm = filePath.replace(/\\/g, "/");
  const m = norm.match(/^(.*\/workspace\/apps\/[^/]+)\/(.+)$/i);
  return m ? { root: m[1], rel: m[2] } : null;
}

/** Rejection message when the target is a harness-owned baseline file, or null
 *  when the app has no scaffold manifest or the file isn't owned. */
function ownedBaselineRejection(filePath: string): string | null {
  const parts = appRootAndRel(filePath);
  if (!parts) return null;
  const manifestPath = `${parts.root}/${SCAFFOLD_MANIFEST_REL}`;
  if (!existsSync(manifestPath)) return null;
  let owned: string[];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as { ownedPaths?: unknown };
    owned = Array.isArray(parsed.ownedPaths) ? (parsed.ownedPaths as string[]) : [];
  } catch {
    return null; // a corrupt manifest must not block writes
  }
  if (!owned.includes(parts.rel)) return null;
  return (
    `Write rejected: ${parts.rel} is part of the harness-generated project baseline ` +
    `(package.json / vite.config / tsconfig) and is locked. Add your app code under src/ instead — ` +
    `and change dependencies with \`npm install <pkg>\`, not by hand-editing package.json.`
  );
}

/** True when filePath is a harness-owned scaffold baseline file locked by an
 *  app's scaffold manifest. The shell guard (security/shell-path-guard.ts) calls
 *  this so a bash redirect/cp/mv/rm can't do what the write/edit lock forbids —
 *  same manifest is the single source of truth, so the two enforcement points
 *  can't drift. */
export function isLockedBaselinePath(filePath: string): boolean {
  return ownedBaselineRejection(filePath) !== null;
}

export function checkAppWrite(filePath: string, content: string): WriteGuardResult {
  if (!isUnderAppsDir(filePath)) return { allow: true };

  const baseline = ownedBaselineRejection(filePath);
  if (baseline) return { allow: false, reason: "harness-owned baseline file", message: baseline };

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
