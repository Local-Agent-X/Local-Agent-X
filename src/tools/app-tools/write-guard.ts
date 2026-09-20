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
import { readRunTargetManifest } from "../app-run-target.js";

export interface WriteGuardResult {
  allow: boolean;
  reason?: string;
  /** Full agent-facing rejection message. When set, the tool surfaces it
   *  verbatim instead of the generic CDN-oriented writeGuardRejectionMessage. */
  message?: string;
  /** Non-blocking nudge delivered alongside a SUCCESSFUL write (allow: true).
   *  Used when the write is permitted but almost certainly a mistake — e.g.
   *  hand-editing a built artifact the next build will overwrite. */
  warn?: string;
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
 *  app's scaffold manifest. The shell guard (security/shell-mutation-guard.ts) calls
 *  this so a bash redirect/cp/mv/rm can't do what the write/edit lock forbids —
 *  same manifest is the single source of truth, so the two enforcement points
 *  can't drift. */
export function isLockedBaselinePath(filePath: string): boolean {
  return ownedBaselineRejection(filePath) !== null;
}

/** Warn text (never a block) when the target is a built artifact of a
 *  static-build app: the next build regenerates it, so a hand-edit silently
 *  vanishes. Scoped to apps carrying a run-target manifest (mode
 *  static-build) — unmarked apps are untouched — and conservative: any doubt
 *  (absent/corrupt manifest, ambiguous layout) means no warn. Rule:
 *    - distDir a real subdirectory ("dist") → artifact iff rel is under
 *      `${distDir}/`.
 *    - distDir "." (app serves from its root: index.static.html + assets/) →
 *      artifact iff rel is under assets/ AND a sibling src/ dir exists —
 *      evidence there IS source to edit instead; without src/, the assets
 *      may BE the hand-authored source. */
function builtArtifactWarning(filePath: string): string | null {
  const parts = appRootAndRel(filePath);
  if (!parts) return null;
  const manifest = readRunTargetManifest(parts.root);
  if (!manifest) return null; // absent or corrupt manifest → fail-open, no warn
  const dist = manifest.distDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const isArtifact = dist === "" || dist === "."
    ? parts.rel.startsWith("assets/") && existsSync(`${parts.root}/src`)
    : parts.rel.startsWith(`${dist}/`);
  if (!isArtifact) return null;
  return (
    "This file is a build artifact — your change will be overwritten by the next build. " +
    "Edit the app's source and run app_rebuild instead."
  );
}

export function checkAppWrite(filePath: string, content: string): WriteGuardResult {
  if (!isUnderAppsDir(filePath)) return { allow: true };

  const baseline = ownedBaselineRejection(filePath);
  if (baseline) return { allow: false, reason: "harness-owned baseline file", message: baseline };

  for (const host of BLOCKED_CDNS) {
    if (content.includes(host)) {
      const reason = `references blocked CDN host '${host}'`;
      return {
        allow: false,
        reason,
        // Name the route out. "Inline or self-host" alone left the model with
        // no way to GET the bytes it was told to self-host, so it retried the
        // same CDN tag (live 2026-09-20, fonts.googleapis.com).
        message:
          `Write rejected: ${reason}. The preview iframe cannot reach external CDNs, so this would render unstyled. ` +
          (isFontHost(host)
            ? `Either use a system font stack (font-family: system-ui, -apple-system, "Segoe UI", sans-serif), ` +
              `or fetch the font CSS and the .woff2 files with the \`http_request\` tool and write them into the app.`
            : `Fetch the library with the \`http_request\` tool and write it into the app as a local file, ` +
              `then reference that local path.`),
      };
    }
  }

  if (isHtml(filePath) && content.length >= VIEWPORT_CHECK_MIN_BYTES) {
    if (!/<meta[^>]+name=["']viewport["']/i.test(content)) {
      const reason = "html missing <meta name=\"viewport\"> (required for mobile-correct rendering)";
      return {
        allow: false,
        reason,
        message:
          `Write rejected: ${reason}. Add ` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"> inside <head> and write again.`,
      };
    }
  }

  return { allow: true, warn: builtArtifactWarning(filePath) ?? undefined };
}

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const isFontHost = (host: string): boolean => FONT_HOSTS.includes(host);

/** Fallback line for a rejection that carries no `message` of its own.
 *  Deliberately says nothing about CDNs: this used to append "the preview
 *  iframe blocks external CDNs (see AGENTS.md). Inline or self-host." to
 *  EVERY rejection, so a model that merely forgot a viewport meta tag was
 *  sent to read about CDNs. Each reason above states its own remedy. */
export function writeGuardRejectionMessage(reason: string): string {
  return `Write rejected: ${reason}.`;
}
