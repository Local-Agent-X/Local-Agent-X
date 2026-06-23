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
import { join, relative } from "node:path";

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
