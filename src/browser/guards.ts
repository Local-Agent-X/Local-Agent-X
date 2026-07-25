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
        await fulfillWithAgentCsp(route);
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
 * egress primitives (fetch / XHR / WebSocket / sendBeacon / dynamic <script> src)
 * are governed at the per-hop request evaluator: a taint-aware payload scan
 * (src/browser/page-egress-taint.ts) blocks a cross-registrable-domain request
 * that actually carries tainted / canary bytes for the session, on BOTH backends
 * (in-app WebContentsView session.webRequest, and the CDP guard below). Re-encoding
 * those primitives as a public, bypassable regex denylist here added only false
 * positives (createElement, `.src =`, `.submit(` appear in tons of legit DOM
 * scripts) and a false sense that the regex was doing the work — an evaluate
 * script's fetch rides the SAME session network stack as the page, so the
 * request-layer gate already covers it. Those egress patterns stay RETIRED.
 * (An earlier same-site CSP was tried for this and reverted — it broke every
 * multi-CDN site; see src/browser/csp-policy.ts for why.)
 *
 * What remains here is exactly what the request-layer gate does NOT cover:
 *   1. Read-into-model-context leaks — a script can read a secret (cookie,
 *      storage, password field) and RETURN it as the evaluate result straight
 *      to the model provider with ZERO network egress. No network gate can see
 *      that channel, so these reads must still be blocked.
 *   2. Dynamic code execution — eval / Function / string-timer / indirect-eval /
 *      bracket global access / dynamic import / Reflect.apply / new Proxy. These
 *      manufacture new code contexts the static scanner (and CSP posture) can't
 *      reason about; they stay blocked, guarded against obfuscation by the
 *      \uXXXX/\xXX normalization AND the string-literal constant folding that
 *      scanEvaluateScript applies below before matching.
 *   3. WebRTC — RTCPeerConnection. WebRTC data channels bypass the HTTP-stack
 *      request evaluator (raw UDP, not an onBeforeRequest hop), so they are the
 *      one egress-ish primitive that must stay in the regex (belt-and-suspenders
 *      with the partition's disable_non_proxied_udp). EventSource kept conservatively.
 *   4. Worker / alternate code contexts and nav/origin manipulation.
 *
 * Obfuscation bypass is mitigated by normalizing `\uXXXX` and `\xXX` escapes
 * and by constant-folding adjacent string literals before matching, so every
 * pattern below is tested against the REASSEMBLED script as well as the raw
 * one. canonical-check: this is the ONE evaluate blocklist.
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
  // NOTE — the old concat obfuscation guard (a pattern that flagged ANY `+`
  // with a short all-lowercase string literal sitting between two other `+`
  // operands) lived here and was deliberately REMOVED. That removal is a NET
  // STRENGTHENING of this blocklist, not a loosening, and the reason belongs in
  // the file rather than a commit message:
  //   - It was a GUESS that concatenation MIGHT rebuild a blocked identifier,
  //     so it blocked `w + "px" + h` and `count + "of" + total` — shapes that
  //     appear in almost every legitimate DOM script — while still MISSING the
  //     real bypasses it was aimed at: an identifier assembled into a variable
  //     ("loc" + "alStorage" assigned to `k`, then `window[k]`) matched nothing
  //     at all, and the bracket form was caught only incidentally by the
  //     bracket-access rules further up.
  //   - scanEvaluateScript now CONSTANT-FOLDS adjacent string literals and runs
  //     this entire list against the reassembled text, so both of those hit
  //     their real pattern (/\blocalStorage\b/, /\[\s*['"]eval['"]\s*\]/).
  // Strictly more real bypasses caught, and zero benign scripts blocked.
];

/** Two adjacent string literals joined by `+` — `"ev" + "al"`, `'loc' + "al"`.
 *  Deliberately simple: a quote, a run of characters that are neither quote nor
 *  backslash nor newline, the SAME quote, then `+` and a second literal of the
 *  same shape. No nested quantifiers and no alternation over one span, so it
 *  cannot backtrack catastrophically on a long concatenation chain, and the
 *  excluded newline keeps every fold inside a single source line. */
const STRING_CONCAT_PAIR = /(['"])([^'"\\\n]*)\1\s*\+\s*(['"])([^'"\\\n]*)\3/g;

/** Hard cap on folding passes so a pathological script can't spin. Each pass
 *  at least halves the literals in a chain, so this covers 1024-part chains. */
const MAX_FOLD_PASSES = 10;

/**
 * Constant-fold adjacent string literals, repeatedly until the text stops
 * changing (bounded by MAX_FOLD_PASSES). This is what replaced the old
 * "concatenation looks suspicious" pattern: instead of GUESSING that a `+`
 * might rebuild a blocked identifier, we actually reassemble it and hand the
 * result to the real patterns.
 *
 * Literal-to-literal ONLY — template literals, variables and parenthesized
 * expressions are left alone. Reassembling those needs a real parser, not a
 * regex, and the request-layer gates remain the enforcement floor regardless.
 */
function foldStringConcats(text: string): string {
  let folded = text;
  for (let pass = 0; pass < MAX_FOLD_PASSES; pass++) {
    const next = folded.replace(
      STRING_CONCAT_PAIR,
      (_match, quote: string, left: string, _rightQuote: string, right: string) =>
        `${quote}${left}${right}${quote}`,
    );
    if (next === folded) break;
    folded = next;
  }
  return folded;
}

/**
 * Check a user-supplied evaluate() script against the block list. Returns
 * the offending pattern's source if blocked, or null if safe.
 *
 * Every pattern is tested against THREE variants of the script:
 *   1. the raw text exactly as supplied;
 *   2. the escape-normalized text (`\uXXXX` / `\xXX` decoded), so an escaped
 *      identifier cannot hide from a literal pattern;
 *   3. the constant-folded text (adjacent string literals merged, applied to
 *      the NORMALIZED text so an escape+concat combo collapses too), so an
 *      identifier reassembled from pieces hits the pattern it was hiding from.
 */
export function scanEvaluateScript(script: string): string | null {
  // Normalize common obfuscations before matching.
  const normalized = script
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const variants = [script, normalized, foldStringConcats(normalized)];
  for (const pat of BLOCKED_EVAL_PATTERNS) {
    for (const variant of variants) {
      if (pat.test(variant)) return pat.source;
    }
  }
  return null;
}

/**
 * Remediation guidance for a blocked evaluate() pattern, categorized so the
 * advice matches WHY the script was blocked. The previous single line ("use
 * http_request for API calls") was actively wrong for storage/DOM reads —
 * http_request cannot read page state — so it mis-steered the agent. Both block
 * paths route through here (EvaluateBlockedError on the in-app backend and
 * handleEvaluate at the tool layer) so their text stays identical.
 *
 * Classification reads the pattern source that scanEvaluateScript returns; every
 * source in BLOCKED_EVAL_PATTERNS carries its identifying token verbatim (e.g.
 * "cookie", "localStorage", "credentials", "password", "EventSource"), so a
 * substring test on the source is a stable proxy for the pattern's class. The
 * pattern source is always echoed for debugging.
 */
export function evaluateBlockMessage(patternSource: string): string {
  const prefix = `Blocked: script contains restricted pattern (${patternSource}). `;
  // (1) Read-into-model-context leaks: cookie / web storage / credentials /
  //     password field. The read itself is the leak, so point at the sanctioned
  //     read paths — NOT http_request, which can't see page state at all.
  if (/cookie|localStorage|sessionStorage|indexedDB|credentials|password/i.test(patternSource)) {
    return prefix +
      "Reading page storage or cookies through evaluate() is blocked to keep secrets out of tool output. " +
      "To read visible page content use the `extract` or `snapshot` actions; if you need the page's login state, ask the user.";
  }
  // (3) WebRTC / EventSource: realtime egress primitives that bypass the
  //     request-layer gate. There is no evaluate-side substitute.
  if (/EventSource|RTCPeerConnection/i.test(patternSource)) {
    return prefix + "This realtime connection primitive is blocked in evaluate().";
  }
  // (2)/(4) Dynamic code execution, workers, and nav/origin manipulation.
  return prefix +
    "Dynamic code execution is not allowed in evaluate() — use plain DOM inspection (querySelector, textContent, getAttribute) instead.";
}

/** Typed refusal for a scanEvaluateScript hit — same categorized message the
 *  tool-layer (CDP) path produces, thrown BEFORE any bridge call: a blocked
 *  script never reaches the view. */
export class EvaluateBlockedError extends Error {
  constructor(pattern: string) {
    super(evaluateBlockMessage(pattern));
    this.name = "EvaluateBlockedError";
  }
}

// Sensitive-page classification and the browserSecrecy read ladder moved to
// sensitive-pages.ts (400-LOC gate). Re-exported so the many existing
// consumers keep importing from guards.js.
export {
  browserSecrecyLevel,
  classifySensitivePage,
  isSecretBearingCategory,
  runWithSensitiveReadGrant,
  safeBrowserPageLabel,
  secrecyOpenWarning,
  sensitivePageActionDecision,
  sensitivePageStub,
  type SensitivePageCategory,
  type SensitivePageDecision,
} from "./sensitive-pages.js";
