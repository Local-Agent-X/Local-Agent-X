/**
 * Browser safety guards — request validation and evaluate() script pattern
 * blocking. Extracted from browser-tools.ts so the tool definition stays
 * under the file-size cap.
 */
import type { BrowserContext } from "playwright";
import { evaluateEgressForUrl } from "../security/layer/index.js";
import { getRuntimeConfig } from "../config.js";

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
 * redirected request, so per-hop coverage is automatic once installed.
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
 * Patterns that must be blocked in `browser evaluate` scripts. Covers
 * credential extraction, network exfiltration, dynamic code execution, and
 * common indirect-eval obfuscations. Obfuscation bypass is mitigated by
 * normalizing `\uXXXX` and `\xXX` escapes before pattern matching.
 */
export const BLOCKED_EVAL_PATTERNS: readonly RegExp[] = [
  // Password / credential extraction
  /\[\s*type\s*=\s*['"]?password['"]?\s*\]/i,
  /input\[\s*type\s*=\s*['"]?password['"]?/i,
  /\btype\s*===?\s*['"]password['"]/i,
  // Network exfiltration
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bnew\s+WebSocket\b/i,
  /\bnavigator\.sendBeacon\b/i,
  /\bwindow\.open\b/i,
  /\bimportScripts\b/i,
  // Image/form-based exfiltration
  /\bnew\s+Image\b/i,
  /\.src\s*=/i,
  /\.submit\s*\(/i,
  /\.action\s*=/i,
  /createElement\s*\(/i,
  // Storage / credential theft
  /\bdocument\.cookie\b/i,
  /\blocalStorage\b/i,
  /\bsessionStorage\b/i,
  /\bindexedDB\b/i,
  /\bcredentials\b/i,
  // Dynamic code execution (direct + indirect)
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /\bsetTimeout\s*\(\s*['"]/i,
  /\bsetInterval\s*\(\s*['"]/i,
  /\(\s*\d\s*,\s*eval\s*\)/i,
  /\[\s*['"]eval['"]\s*\]/i,
  /\bwindow\s*\[\s*['"]/i,
  /\bglobalThis\s*\[\s*['"]/i,
  /\bself\s*\[\s*['"]/i,
  // Reflect / Proxy
  /\bReflect\s*\.\s*apply\b/i,
  /\bnew\s+Proxy\b/i,
  // Dynamic import
  /\bimport\s*\(/i,
  // Workers / alt transports
  /\bnew\s+Worker\b/i,
  /\bServiceWorker\b/i,
  /\bSharedWorker\b/i,
  /\bnew\s+EventSource\b/i,
  /\bRTCPeerConnection\b/i,
  // document.domain manipulation
  /\bdocument\.domain\b/i,
  // String concatenation bypass
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
// same secrets its DOM does.
const SECRET_READING_ACTIONS = new Set([
  "snapshot", "observe", "extract", "screenshot", "evaluate", "read_console", "read_network",
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
