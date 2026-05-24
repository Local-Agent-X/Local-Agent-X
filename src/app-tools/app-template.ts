/**
 * App-template seeder — drops a working `index.html` + `AGENTS.md` into a
 * freshly-created `workspace/apps/<id>/` folder BEFORE the build agent's
 * first turn. The agent then edits a known-good starter instead of
 * generating from scratch, which dramatically cuts first-turn regressions
 * on weaker models (Tailwind CDN attempts, missing viewport meta, CSP
 * refusals, etc).
 *
 * Idempotent: both files no-op when present so re-invocation across
 * update/retry flows can't clobber user customizations.
 *
 * Disk-touching by design — the build_app caller invokes this immediately
 * after `mkdirSync(appDir, { recursive: true })`.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SeedResult {
  /** Files actually written this call. Empty when both pre-existed. */
  written: string[];
  /** Files that were skipped because they already existed. */
  skipped: string[];
}

/**
 * Seed the starter pair into `appDir`. Caller is responsible for ensuring
 * `appDir` exists. Returns a summary of what landed vs. what was preserved.
 */
export function seedAppTemplate(appDir: string, appName: string): SeedResult {
  const written: string[] = [];
  const skipped: string[] = [];

  const indexPath = join(appDir, "index.html");
  if (existsSync(indexPath)) {
    skipped.push("index.html");
  } else {
    writeFileSync(indexPath, renderStarterHtml(appName), "utf-8");
    written.push("index.html");
  }

  const agentsPath = join(appDir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    skipped.push("AGENTS.md");
  } else {
    writeFileSync(agentsPath, renderAgentsMd(appName), "utf-8");
    written.push("AGENTS.md");
  }

  return { written, skipped };
}

function renderStarterHtml(appName: string): string {
  const title = humanizeName(appName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; connect-src 'self'" />
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  :root {
    --bg: #ffffff;
    --surface: #fafafa;
    --text: #111418;
    --text-muted: #5b6470;
    --border: #e6e8ec;
    --accent: #0b66ff;
    --accent-contrast: #ffffff;
    --radius: 10px;
    --shadow: 0 1px 2px rgba(17, 20, 24, 0.04), 0 4px 12px rgba(17, 20, 24, 0.04);
    --max-width: 880px;
    --space-1: 0.5rem;
    --space-2: 1rem;
    --space-3: 1.5rem;
    --space-4: 2.5rem;
    --space-5: 4rem;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 16px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  main {
    max-width: var(--max-width);
    margin: 0 auto;
    padding: var(--space-5) var(--space-3);
  }
  header.hero {
    padding: var(--space-4) 0 var(--space-3);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--space-4);
  }
  header.hero h1 {
    margin: 0 0 var(--space-1);
    font-size: clamp(1.75rem, 4vw, 2.5rem);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  header.hero p {
    margin: 0;
    color: var(--text-muted);
    font-size: 1.05rem;
  }
  section.content {
    display: grid;
    gap: var(--space-3);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    box-shadow: var(--shadow);
  }
  .card h2 {
    margin: 0 0 var(--space-1);
    font-size: 1.1rem;
    font-weight: 600;
  }
  .card p { margin: 0; color: var(--text-muted); }
  footer {
    margin-top: var(--space-5);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  @media (min-width: 720px) {
    main { padding: var(--space-5) var(--space-4); }
  }
</style>
</head>
<body>
<main>
  <header class="hero">
    <h1>${escapeHtml(title)}</h1>
    <p>Edit this starter — replace the hero copy, swap in real sections, and ship.</p>
  </header>

  <section class="content" id="app">
    <article class="card">
      <h2>Start here</h2>
      <p>This is a placeholder card. Replace the markup inside <code>&lt;section id="app"&gt;</code> with your actual UI.</p>
    </article>
  </section>

  <footer>
    <span>Built locally.</span>
  </footer>
</main>
<script>
  (function () {
    var app = document.getElementById("app");
    if (!app) return;
    // Hook for app logic. Inline only — external scripts are blocked by CSP.
  })();
</script>
</body>
</html>
`;
}

function renderAgentsMd(_appName: string): string {
  return `# Environment

This app runs in a sandboxed iframe under this Content Security Policy:

    script-src 'self' 'unsafe-inline'
    style-src  'self' 'unsafe-inline'
    img-src    'self' data: https: blob:
    font-src   'self' data:
    connect-src 'self'

What that means:
- CDN scripts (Tailwind CDN, jsdelivr, unpkg, cdnjs) are blocked.
- Google Fonts and any @import from external URLs are blocked.
- Inline <style> and inline <script> work. External \`<script src>\` only if the file lives in this directory.
- Images may be data:, blob:, https: URLs, or local paths. Fonts must be system stack.

Files in this directory are served at /apps/<id>/. Paths in index.html resolve relative to it.

You are editing this folder. An index.html starter is already present — modify it in place rather than rewriting from scratch.

Runtime errors in the preview are forwarded back to you automatically. Fix what surfaces.
`;
}

function humanizeName(slug: string): string {
  const cleaned = slug.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "New App";
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
