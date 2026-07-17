/**
 * Browser safety guards — request validation and evaluate() script pattern
 * blocking. Extracted from browser-tools.ts so the tool definition stays
 * under the file-size cap.
 */
import type { BrowserContext } from "playwright";
import { evaluateEgressForUrl } from "../security/layer/index.js";
import { getRuntimeConfig } from "../config.js";
import { isTopLevelDocument, fulfillWithAgentCsp } from "./csp-inject.js";

/** Schemes that must never be reached via a top-level document navigation —
 *  click-induced, redirect, or JS. Sub-resources (a page's own data: image,
 *  etc.) are NOT globally killed; only the main-frame document load is. */
const BLOCKED_NAV_SCHEMES = new Set(["file:", "chrome:", "view-source:", "data:"]);

/** Contexts that already have the request guard installed. Shared mode reuses
 *  one default context across every getPage() call, so without this the route
 *  handler would stack (and double-handle each request). */
const guardedContexts = new WeakSet<BrowserContext>();
const guardInstallations = new WeakMap<BrowserContext, Promise<void>>();

/**
 * Install a single context-level request guard so EVERY navigation a page in
 * this context makes — click/act/fill-induced, form-submit, JS-redirect,
 * meta-refresh, and every HTTP-redirect hop — is SSRF/scheme-checked by
 * construction at the request layer, before the request leaves. This is the
 * invariant that closes the gap where per-call checks only gated the initial
 * URL of navigate/new_tab (R4-01 click-to-internal, R4-02 redirect).
 *
 * Playwright fires the route handler for the original request AND for each
 * redirected request, so per-hop coverage is automatic for the continue()
 * path (sub-resources and non-document navigations). NOTE the exception for
 * the top-level document: it takes the route.fetch()+fulfill() path, and
 * route.fetch() follows HTTP redirects INTERNALLY — so the guard's per-hop
 * diagnostic evaluateEgressForUrl() is NOT re-run on a document's intermediate
 * redirect hops. This stays SSRF-safe because the context launches behind the
 * mandatory pinned egress proxy, which validates DNS and pins the socket for
 * every hop regardless; only the extra diagnostic layer is skipped for the
 * document redirect chain, not the enforcement.
 *
 * The guard is scoped to the agent's own context (the manager only ever calls
 * this on contexts it acquires from the dedicated agent Chrome — never the
 * user's real browser, which the agent can't drive at all; see launcher.ts).
 * Installed at most once per context.
 */
export async function installRequestGuard(context: BrowserContext): Promise<void> {
  if (guardedContexts.has(context)) return;
  const pending = guardInstallations.get(context);
  if (pending) return pending;

  const selfPort = process.env.LAX_PORT ?? String(getRuntimeConfig().port);

  const installation = context.route("**/*", async (route, request) => {
    let url: string;
    try {
      url = request.url();
    } catch {
      await route.continue();
      return;
    }

    let scheme: string;
    try {
      scheme = new URL(url).protocol;
    } catch {
      // Unparseable URL on a navigation request → fail closed; otherwise let
      // the browser deal with it as a normal (sub-resource) request.
      if (request.isNavigationRequest()) { await route.abort("blockedbyclient"); return; }
      await route.continue();
      return;
    }

    // Non-http(s) requests: only block top-level DOCUMENT navigations to the
    // dangerous schemes. A page's own data: image / blob: etc. passes through.
    if (scheme !== "http:" && scheme !== "https:") {
      const isTopDoc = request.resourceType() === "document" && request.isNavigationRequest();
      if (isTopDoc && BLOCKED_NAV_SCHEMES.has(scheme)) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
      return;
    }

    // Run the canonical URL policy here for early denial and diagnostics. The
    // mandatory browser proxy owns DNS validation and pinned socket creation.
    try {
      const decision = evaluateEgressForUrl(url, selfPort);
      if (!decision.allowed) {
        await route.abort("blockedbyclient");
        return;
      }
      // Only the top-level document response carries an enforceable document
      // CSP, so only that one request pays the fetch+fulfill round-trip; every
      // sub-resource keeps the cheap continue() path untouched.
      if (isTopLevelDocument(request)) {
        await fulfillWithAgentCsp(route, url);
        return;
      }
      await route.continue();
    } catch {
      if (request.isNavigationRequest()) { await route.abort("blockedbyclient"); return; }
      await route.continue();
    }
  });
  guardInstallations.set(context, installation);
  try {
    await installation;
    guardedContexts.add(context);
  } finally {
    guardInstallations.delete(context);
  }
}

/**
 * Patterns that must be blocked in `browser evaluate` scripts.
 *
 * SCOPE: this list is deliberately NOT the network-egress defense. Cross-origin
 * egress primitives (fetch / XHR / WebSocket / sendBeacon / img-src / form-action
 * / importScripts / dynamic <script> src) are now blocked BY CONSTRUCTION by the
 * per-document agent CSP that both backends stamp on every top-level document —
 * see src/browser/csp-policy.ts (buildAgentCsp) and desktop/src/browser-csp.ts.
 * Chromium's connect-src / img-src / form-action / script-src / worker-src
 * enforce those by construction, so re-encoding them as a public, bypassable
 * regex denylist here added only false positives (createElement, `.src =`,
 * `.submit(` appear in tons of legit DOM scripts) and a false sense that the
 * regex was doing the work. Those egress patterns have been RETIRED.
 *
 * What remains here is exactly what CSP does NOT cover:
 *   1. Read-into-model-context leaks — a script can read a secret (cookie,
 *      storage, password field) and RETURN it as the evaluate result straight
 *      to the model provider with ZERO network egress. CSP is irrelevant to
 *      that channel, so these reads must still be blocked.
 *   2. Dynamic code execution — eval / Function / string-timer / indirect-eval /
 *      bracket global access / dynamic import / Reflect.apply / new Proxy. These
 *      manufacture new code contexts the static scanner (and CSP posture) can't
 *      reason about; they stay blocked, guarded against escape-obfuscation by
 *      the \uXXXX/\xXX normalization below plus the string-concat pattern.
 *   3. WebRTC — RTCPeerConnection. WebRTC data channels are a KNOWN CSP bypass:
 *      connect-src does NOT reliably gate them, so this is the one egress-ish
 *      primitive that must stay in the regex. EventSource kept conservatively.
 *   4. Worker / alternate code contexts and nav/origin manipulation.
 *
 * Obfuscation bypass is mitigated by normalizing `\uXXXX` and `\xXX` escapes
 * before matching. canonical-check: this is the ONE evaluate blocklist.
 */
export const BLOCKED_EVAL_PATTERNS: readonly RegExp[] = [
  // (1) Read-into-model-context leaks — password field READS. A script can read
  // the value and return it as the evaluate result with no network egress, so
  // CSP cannot help here; the read itself must be blocked.
  /\[\s*type\s*=\s*['"]?password['"]?\s*\]/i,
  /input\[\s*type\s*=\s*['"]?password['"]?/i,
  /\btype\s*===?\s*['"]password['"]/i,
  // (1) Read-into-model-context leaks — credential / storage READS. Same reason:
  // read a secret, RETURN it to the model — no network hop for CSP to catch.
  /\bdocument\.cookie\b/i,
  /\blocalStorage\b/i,
  /\bsessionStorage\b/i,
  /\bindexedDB\b/i,
  /\bcredentials\b/i,
  // (2) Dynamic code execution (direct + indirect). NOTE: `Function` is
  // CASE-SENSITIVE on purpose — the real constructor is always capital-F
  // (`new Function(...)`, `Function(...)()`); a case-insensitive match here
  // also caught the benign lowercase `function` keyword and blocked every
  // function declaration/expression/IIFE in legit evaluate scripts.
  /\beval\s*\(/i,
  /\bFunction\s*\(/,
  /\bsetTimeout\s*\(\s*['"]/i,
  /\bsetInterval\s*\(\s*['"]/i,
  /\(\s*\d\s*,\s*eval\s*\)/i,
  /\[\s*['"]eval['"]\s*\]/i,
  /\bwindow\s*\[\s*['"]/i,
  /\bglobalThis\s*\[\s*['"]/i,
  /\bself\s*\[\s*['"]/i,
  /\bReflect\s*\.\s*apply\b/i,
  /\bnew\s+Proxy\b/i,
  /\bimport\s*\(/i,
  // (3) WebRTC — CRITICAL keep. Data channels are a known CSP connect-src
  // bypass, so this is the one egress-ish primitive the regex must still own.
  // EventSource kept conservatively alongside it.
  /\bnew\s+EventSource\b/i,
  /\bRTCPeerConnection\b/i,
  // (4) Worker / alternate code contexts.
  /\bnew\s+Worker\b/i,
  /\bServiceWorker\b/i,
  /\bSharedWorker\b/i,
  // (4) Nav / origin manipulation.
  /\bwindow\.open\b/i,
  /\bdocument\.domain\b/i,
  // Obfuscation guard: string-concatenation bypass of the kept eval/Function
  // patterns (works with the \uXXXX/\xXX normalization above).
  /\+\s*['"][a-z]{1,5}['"]\s*\+/i,
];

/**
 * Check a user-supplied evaluate() script against the block list. Returns
 * the offending pattern's source if blocked, or null if safe.
 */
export function scanEvaluateScript(script: string): string | null {
  // Normalize common obfuscations before matching.
  const normalized = script
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (const pat of BLOCKED_EVAL_PATTERNS) {
    if (pat.test(script) || pat.test(normalized)) return pat.source;
  }
  return null;
}

export type SensitivePageCategory =
  | "password manager"
  | "cloud metadata"
  | "administration panel"
  | "financial account"
  | "account recovery"
  | "private key management";

export interface SensitivePageDecision {
  disposition: "allow" | "approval-required" | "blocked";
  category?: SensitivePageCategory;
  reason?: string;
  page: string;
}

const MUTATING_BROWSER_ACTIONS = new Set([
  "click", "click_text", "fill", "select", "act", "dialog_accept",
]);
// read_console/read_network belong here too: a secret-bearing page's console
// output and request URLs are page-controlled channels that can carry the
// same secrets its DOM does. bookmark_add reads the page's url+title AND
// persists them to disk — on a vault-ish page that's a secret write-out.
const SECRET_READING_ACTIONS = new Set([
  "snapshot", "observe", "extract", "screenshot", "evaluate", "read_console", "read_network", "bookmark_add",
]);

function pageLabel(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function safeBrowserPageLabel(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const sensitive = classifySensitivePage(rawUrl);
    return sensitive && isSecretBearingCategory(sensitive.category) ? `${url.origin}/[sensitive-path-redacted]` : pageLabel(url);
  } catch { return "[unavailable]"; }
}

export function isSecretBearingCategory(category: SensitivePageCategory): boolean {
  return category === "password manager" || category === "account recovery" || category === "private key management";
}

export function sensitivePageStub(rawUrl: string): string | null {
  const sensitive = classifySensitivePage(rawUrl);
  if (!sensitive || !isSecretBearingCategory(sensitive.category)) return null;
  return [
    "[SENSITIVE PAGE CONTENT WITHHELD]",
    `Category: ${sensitive.category}`,
    `Page: ${sensitive.page}`,
    "Status: Page content, title, controls, and values were not read or returned.",
    "Explicit user approval is required for high-risk actions; structural and secret-reading actions remain blocked.",
  ].join("\n");
}

export function classifySensitivePage(rawUrl: string): { category: SensitivePageCategory; page: string } | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const page = pageLabel(url);
  const secretPage = `${url.origin}/[sensitive-path-redacted]`;

  if (host === "169.254.169.254" || host === "metadata.google.internal") return { category: "cloud metadata", page };
  if (/(^|\.)(1password|bitwarden|lastpass|dashlane)\.(com|eu)$/.test(host) || host.endsWith(".keepersecurity.com") || /\/(passwords?|vault)(\/|$)/.test(path)) {
    return { category: "password manager", page: secretPage };
  }
  if (/\/(recover|recovery|forgot-password|reset-password|account-recovery)(\/|$)/.test(path)) return { category: "account recovery", page: secretPage };
  if (/\/(private-?keys?|ssh-keys?|api-keys?|signing-keys?|certificates?)(\/|$)/.test(path)) return { category: "private key management", page: secretPage };
  if (["console.aws.amazon.com", "console.cloud.google.com", "portal.azure.com", "admin.microsoft.com"].includes(host) || /\/(admin|administrator|control-panel|management)(\/|$)/.test(path)) {
    return { category: "administration panel", page };
  }
  if (/(^|\.)(paypal|stripe|coinbase|venmo|wise|chase|bankofamerica|wellsfargo|capitalone|fidelity|schwab|americanexpress)\.com$/.test(host) || /(^|\.)(bank|banking)\./.test(host) || /\/(banking|billing|payments?|payouts?|transfers?|wire)(\/|$)/.test(path)) {
    return { category: "financial account", page };
  }
  return null;
}

export function sensitivePageActionDecision(rawUrl: string, action: string): SensitivePageDecision {
  const sensitive = classifySensitivePage(rawUrl);
  if (!sensitive) return { disposition: "allow", page: "" };
  if (SECRET_READING_ACTIONS.has(action) && isSecretBearingCategory(sensitive.category)) {
    return {
      disposition: "blocked", category: sensitive.category, page: sensitive.page,
      reason: `Reading page contents is blocked on this ${sensitive.category} page to keep secrets out of tool results and logs.`,
    };
  }
  if (MUTATING_BROWSER_ACTIONS.has(action) || action === "evaluate") {
    return {
      disposition: "approval-required", category: sensitive.category, page: sensitive.page,
      reason: `This high-risk browser action targets a ${sensitive.category} page.`,
    };
  }
  return { disposition: "allow", category: sensitive.category, page: sensitive.page };
}
