/**
 * Browser safety guards — request-layer SSRF/scheme guard and evaluate()
 * script pattern blocking. Extracted from browser-tools.ts so the tool
 * definition stays under the file-size cap.
 */
import type { BrowserContext } from "playwright";
import { loadEgressConfig, validateUrlWithDns } from "../security/network-policy.js";

/** Schemes that must never be reached via a top-level document navigation —
 *  click-induced, redirect, or JS. Sub-resources (a page's own data: image,
 *  etc.) are NOT globally killed; only the main-frame document load is. */
const BLOCKED_NAV_SCHEMES = new Set(["file:", "chrome:", "view-source:", "data:"]);

/** Contexts that already have the request guard installed. Shared mode reuses
 *  one default context across every getPage() call, so without this the route
 *  handler would stack (and double-handle each request). */
const guardedContexts = new WeakSet<BrowserContext>();

/**
 * Install a single context-level request guard so EVERY navigation a page in
 * this context makes — click/act/fill-induced, form-submit, JS-redirect,
 * meta-refresh, and every HTTP-redirect hop — is SSRF/scheme-checked by
 * construction at the request layer, before the request leaves. This is the
 * invariant that closed the gap left by the legacy per-call DNS pre-check,
 * which only gated the INITIAL url of navigate/new_tab (R4-01
 * click-to-internal, R4-02 redirect). That pre-check also failed OPEN on DNS
 * errors; this guard fails closed on navigation requests and is the single
 * canonical browser URL guard.
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
  guardedContexts.add(context);

  const selfPort = process.env.LAX_PORT ?? "7007";

  await context.route("**/*", async (route, request) => {
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

    // http(s): run the canonical async SSRF gate (scheme + literal-IP + DNS
    // resolve to private/loopback/link-local/metadata). Self-server calls to
    // 127.0.0.1:<selfPort> are allowed by the canonical gate. Fail closed on a
    // navigation request if the check throws; let sub-resources continue so a
    // transient DNS hiccup on an analytics beacon doesn't kill the page.
    try {
      const cfg = loadEgressConfig();
      const decision = await validateUrlWithDns(
        cfg.allowlist,
        cfg.configured,
        selfPort,
        url,
        cfg.mode,
        cfg.localServicePorts,
      );
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
