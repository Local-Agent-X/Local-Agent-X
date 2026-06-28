/**
 * Post-build content gate: catch raw cross-origin network calls a built app
 * makes directly, which the app sandbox CSP (`connect-src 'self'`) blocks at
 * runtime — so the app loads but never gets data. The build teaching tells the
 * model to route external APIs through a connector (/api/connectors), but a
 * model with a strong conventional-web-dev prior (e.g. grok-code-fast) ignores
 * the prose and raw-`fetch`es anyway. This makes that a hard build failure with
 * an actionable message instead of shipping a silently-broken app.
 *
 * Pure read-only scan. Wired into the app-build adapter's terminal so it gates
 * BOTH build strategies (cli-subprocess + in-canonical) at one chokepoint.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

export interface BlockedFetchViolation {
  /** App-relative file path (forward slashes). */
  file: string;
  /** External hosts the file calls directly. */
  hosts: string[];
}

// A network call the sandbox routes through connect-src. `.open(` is excluded
// deliberately — window.open(url) is navigation (allowed), not a fetch; XHR is
// still caught via the XMLHttpRequest keyword the file must reference.
const NETWORK_API = /\bfetch\s*\(|new\s+WebSocket\s*\(|new\s+EventSource\s*\(|\bXMLHttpRequest\b/;
// Absolute http(s)/ws(s) URLs. Same-origin calls are relative (/api/...), so
// any absolute external URL in a network-calling file is the smell.
const ABSOLUTE_URL = /(?:https?|wss?):\/\/([a-z0-9.-]+)/gi;
// Loopback is reachable from a sandboxed app (the CSP allows 127.0.0.1/localhost).
const LOOPBACK = /^(?:localhost|127\.0\.0\.1)$/i;
// XML/SVG namespace URIs and similar identifiers are NOT network calls — they
// appear in createElementNS / setAttributeNS, not fetch. Don't flag them.
const NON_ENDPOINT_HOSTS = new Set([
  "www.w3.org", "w3.org", "schema.org", "www.schema.org",
  "ns.adobe.com", "purl.org", "xmlns.com", "gmpg.org",
]);

// Navigation / markup / CSS contexts where an external URL is fine — it's not a
// connect-src fetch. Checked against the text just before a URL match.
const NAV_OR_ASSET_BEFORE = /(?:\bopen\s*\(|\.href\s*=|\bhref\s*=|\bsrc\s*=|\baction\s*=|\.assign\s*\(|\.replace\s*\(|url\()\s*['"`]?$/i;

const SCAN_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "assets", "dist", "build", "vendor"]);
const MAX_FILES = 200;

/** Pull inline <script> bodies out of HTML; for .js/.mjs return the whole file. */
function networkSource(filePath: string, content: string): string {
  if (/\.html?$/i.test(filePath)) {
    const blocks: string[] = [];
    for (const m of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) blocks.push(m[1]);
    return blocks.join("\n");
  }
  return content;
}

function collectFiles(dir: string, root: string, out: string[]): void {
  if (out.length >= MAX_FILES) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collectFiles(full, root, out);
    } else if (SCAN_EXTENSIONS.has(name.slice(name.lastIndexOf(".")).toLowerCase())) {
      out.push(full);
    }
  }
}

/**
 * Scan a built app dir for raw cross-origin network calls. A file is flagged
 * when it BOTH makes a network call (fetch/WebSocket/EventSource/XHR) AND
 * contains an absolute external URL — the connector pattern uses a relative
 * /api/connectors path, so it never trips this.
 */
export function scanAppForBlockedFetch(appDir: string): { violations: BlockedFetchViolation[] } {
  if (!existsSync(appDir)) return { violations: [] };
  const files: string[] = [];
  collectFiles(appDir, appDir, files);

  const violations: BlockedFetchViolation[] = [];
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    const src = networkSource(file, content);
    if (!NETWORK_API.test(src)) continue;

    const hosts = new Set<string>();
    for (const m of src.matchAll(ABSOLUTE_URL)) {
      const host = m[1].toLowerCase();
      if (LOOPBACK.test(host) || NON_ENDPOINT_HOSTS.has(host)) continue;
      // Skip URLs used for navigation/markup/CSS, not connect-src fetches.
      if (NAV_OR_ASSET_BEFORE.test(src.slice(Math.max(0, m.index - 24), m.index))) continue;
      hosts.add(host);
    }
    if (hosts.size > 0) {
      violations.push({ file: relative(appDir, file).replace(/\\/g, "/"), hosts: [...hosts] });
    }
  }
  return { violations };
}

// ── Startup sanity: catch the "loads to a blank page" class deterministically ──
// Complements render-verify (which catches runtime JS errors once a preview
// loads) with two checks that need no running preview and can't false-positive
// on a valid app: a missing HTML entry, and a <script src> pointing at a file
// that isn't there (a 404 that white-screens the app). Runtime JS errors stay
// render-verify's job — static JS parsing false-positives on ES modules.

export interface StartupError {
  /** App-relative file (or "(app root)"). */
  file: string;
  problem: string;
}

const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi;
// Anything with a scheme (http:, data:), protocol-relative (//), or an anchor
// is not a local file we can resolve — skip it (CDN/external is a separate CSP
// concern, not a missing-file one).
const EXTERNAL_OR_SPECIAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

export function scanAppForStartupErrors(appDir: string): { errors: StartupError[] } {
  if (!existsSync(appDir)) return { errors: [] };
  const files: string[] = [];
  collectFiles(appDir, appDir, files);
  const rel = (f: string) => relative(appDir, f).replace(/\\/g, "/");
  const htmlFiles = files.filter(f => /\.html?$/i.test(f));

  if (htmlFiles.length === 0) {
    return { errors: [{ file: "(app root)", problem: "no HTML file — the app has no entry point to load." }] };
  }

  const errors: StartupError[] = [];
  for (const html of htmlFiles) {
    let content: string;
    try { content = readFileSync(html, "utf8"); } catch { continue; }
    for (const m of content.matchAll(SCRIPT_SRC)) {
      const ref = m[1].trim();
      if (!ref || EXTERNAL_OR_SPECIAL.test(ref)) continue;
      const clean = ref.split(/[?#]/)[0];
      const target = clean.startsWith("/")
        ? join(appDir, clean.slice(1))
        : join(dirname(html), clean);
      if (!existsSync(target)) {
        errors.push({ file: rel(html), problem: `references a missing script "${ref}" — it 404s on load, so the app renders blank.` });
      }
    }
  }
  return { errors };
}

/** Actionable build-failure message naming the broken-on-load files + the fix. */
export function formatStartupErrors(errors: StartupError[]): string {
  const lines = errors.map(e => `  - ${e.file}: ${e.problem}`);
  return (
    "Build rejected: the app would fail on first load:\n" +
    lines.join("\n") +
    "\n\nMake the app render and run out of the box — every <script src> must point " +
    "to a file that exists in the app, and there must be an HTML entry point. " +
    "Fix this, then emit APP_READY."
  );
}

/** Actionable build-failure message naming the offending files + the fix. */
export function formatBlockedFetchError(violations: BlockedFetchViolation[]): string {
  const lines = violations.map(v => `  - ${v.file} → ${v.hosts.join(", ")}`);
  return (
    "Build rejected: the app calls external APIs directly, which the app sandbox " +
    "(CSP connect-src 'self') blocks at runtime — it will load but never get data:\n" +
    lines.join("\n") +
    "\n\nWire each external API through a connector instead: call the connector_create tool " +
    "to define it, then have the app fetch the same-origin proxy /api/connectors/<name>/<path> " +
    "with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__. " +
    "Do NOT fetch external URLs directly. Fix this, then emit APP_READY."
  );
}
