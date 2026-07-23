/**
 * Sensitive-page classification and the browserSecrecy read ladder — split
 * from guards.ts for the 400-LOC gate (guards.ts keeps the request guard and
 * the evaluate() blocklist; guards.ts re-exports this module so consumers
 * keep their import surface).
 *
 * browserSecrecy (config/settings, ordered strictest → most open, default
 * "ask") governs what the agent may READ on sensitive pages:
 *   lockdown — withhold ALL sensitive pages, administration/financial too.
 *   guarded  — administration/financial readable; secret-bearing pages
 *              (password manager / account recovery / key material) silently
 *              withheld. (The pre-ladder shipped behavior.)
 *   ask      — administration/financial readable; reading a secret-bearing
 *              page requires the user's approval (foreground prompt; hard
 *              block when no approval channel exists — autonomous runs stay
 *              safe-by-default).
 *   open     — everything readable; the tool layer surfaces a one-time
 *              warning when a CLOUD-routed model would receive the contents.
 * MUTATING actions on any sensitive page stay approval-gated below "open".
 *
 * The generic path signals C8 dropped (/passwords /vault /api-keys
 * /certificates on an arbitrary host) return here gated by the level: they
 * classify only at "lockdown" and "ask", where the outcome is transparent (a
 * prompt or an explicitly-chosen lockdown) — never at "guarded", whose
 * silent withholding on routine SaaS pages was exactly why C8 removed them.
 * A docs page whose URL contains "api-keys" will therefore prompt at "ask" —
 * acceptable and visible; the ladder is the escape hatch.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getRuntimeConfig } from "../config.js";
import { loadSettings } from "../settings.js";
import type { BrowserSecrecy } from "../types/lax-config.js";

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
  /** True only for the ask-level secret-READ approval: the tool layer must
   *  grant a read unlock for the page URL after the user approves, so the
   *  stub call sites downstream reveal the content for exactly that call. */
  unlocksRead?: boolean;
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

export function browserSecrecyLevel(): BrowserSecrecy {
  const v = (getRuntimeConfig() as { browserSecrecy?: string }).browserSecrecy;
  return v === "lockdown" || v === "guarded" || v === "ask" || v === "open" ? v : "ask";
}

/** The ask-level read unlock. An approved secret READ runs its ENTIRE
 *  dispatch — handlers, backends, the post-dispatch stub backstop — inside
 *  this async context, carrying the approved page URL. sensitivePageStub
 *  reveals content only when asked about that exact URL FROM WITHIN that
 *  dispatch's async call chain: a concurrent session's dispatch is a
 *  different async context and can never piggyback on the grant (a global
 *  URL-keyed map had exactly that window). No release bookkeeping — the
 *  grant dies with the call chain. A wedge-abandoned zombie dispatch keeps
 *  its grant, but its results are discarded, never surfaced. */
const readGrant = new AsyncLocalStorage<string>();

export function runWithSensitiveReadGrant<T>(rawUrl: string, fn: () => Promise<T>): Promise<T> {
  return readGrant.run(rawUrl, fn);
}

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

/**
 * The content-withheld stub every read path serves in place of page content.
 * Level-aware: null at "open" (nothing withheld) and for the exact URL of an
 * approved in-flight read; at "lockdown" it covers ALL sensitive categories;
 * at "guarded"/"ask" only secret-bearing ones, with "ask" telling the model
 * how to trigger the approval prompt (the tool layer prompts on the READ
 * action itself — landing on a page never prompts, re-reading it does).
 */
export function sensitivePageStub(rawUrl: string): string | null {
  const level = browserSecrecyLevel();
  if (level === "open") return null;
  if (readGrant.getStore() === rawUrl) return null;
  const sensitive = classifySensitivePage(rawUrl);
  if (!sensitive) return null;
  const secret = isSecretBearingCategory(sensitive.category);
  if (!secret && level !== "lockdown") return null;
  const status = secret && level === "ask"
    ? "Status: withheld pending approval (browserSecrecy=ask). Re-run the read action (snapshot / extract / observe) and the user will be asked to approve revealing this page."
    : `Status: withheld (browserSecrecy=${level}). Page content, title, controls, and values were not read or returned.`;
  return [
    "[SENSITIVE PAGE CONTENT WITHHELD]",
    `Category: ${sensitive.category}`,
    `Page: ${sensitive.page}`,
    status,
    "Explicit user approval is required for high-risk actions; structural and secret-reading actions remain gated.",
    "You can still navigate away, switch_tab, close_tab, or close the browser without approval.",
  ].join("\n");
}

/**
 * Classify a URL as a sensitive page. HOST-based signals are authoritative and
 * kept intact. PATH-only signals are deliberately narrow: a generic word in an
 * arbitrary host's path is NOT sufficient at every level, because routine SaaS
 * navigation lives at exactly those words ("update billing address", "view my
 * api-keys page") and silently gating it walls off ordinary use.
 *
 * KEPT — HOST (always authoritative): cloud-metadata IPs; password-manager
 *   hosts; cloud consoles; known bank & payment hosts + `bank.`/`banking.`.
 * KEPT — PATH (specific enough on ANY host, every level): account-recovery /
 *   reset-password flows; literal key-material pages (private/ssh/signing keys).
 * LEVEL-GATED — PATH (only at "lockdown" and "ask", where the outcome is a
 *   visible prompt or an explicitly-chosen lockdown): /passwords /vault →
 *   password manager; /api-keys /certificates → private key management.
 *   Never at "guarded" — its silent withholding on these generic SaaS words
 *   was the original C8 over-match.
 * DROPPED (all levels): the admin-panel and financial path groups (/admin,
 *   /billing, /payments, …) — those classify only on a known-sensitive HOST.
 */
export function classifySensitivePage(rawUrl: string): { category: SensitivePageCategory; page: string } | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const page = pageLabel(url);
  const secretPage = `${url.origin}/[sensitive-path-redacted]`;

  if (host === "169.254.169.254" || host === "metadata.google.internal") return { category: "cloud metadata", page };
  if (/(^|\.)(1password|bitwarden|lastpass|dashlane)\.(com|eu)$/.test(host) || host.endsWith(".keepersecurity.com")) {
    return { category: "password manager", page: secretPage };
  }
  if (/\/(recover|recovery|forgot-password|reset-password|account-recovery)(\/|$)/.test(path)) return { category: "account recovery", page: secretPage };
  if (/\/(private-?keys?|ssh-keys?|signing-keys?)(\/|$)/.test(path)) return { category: "private key management", page: secretPage };
  const level = browserSecrecyLevel();
  if (level === "lockdown" || level === "ask") {
    if (/\/(passwords?|vault)(\/|$)/.test(path)) return { category: "password manager", page: secretPage };
    if (/\/(api-keys?|certificates?)(\/|$)/.test(path)) return { category: "private key management", page: secretPage };
  }
  if (["console.aws.amazon.com", "console.cloud.google.com", "portal.azure.com", "admin.microsoft.com"].includes(host)) {
    return { category: "administration panel", page };
  }
  if (/(^|\.)(paypal|stripe|coinbase|venmo|wise|chase|bankofamerica|wellsfargo|capitalone|fidelity|schwab|americanexpress)\.com$/.test(host) || /(^|\.)(bank|banking)\./.test(host)) {
    return { category: "financial account", page };
  }
  return null;
}

export function sensitivePageActionDecision(rawUrl: string, action: string): SensitivePageDecision {
  const sensitive = classifySensitivePage(rawUrl);
  if (!sensitive) return { disposition: "allow", page: "" };
  const level = browserSecrecyLevel();
  if (SECRET_READING_ACTIONS.has(action) && isSecretBearingCategory(sensitive.category)) {
    if (level === "open") return { disposition: "allow", category: sensitive.category, page: sensitive.page };
    if (level === "ask") {
      return {
        disposition: "approval-required", category: sensitive.category, page: sensitive.page, unlocksRead: true,
        reason: `Reading this ${sensitive.category} page reveals its contents to the model, so browserSecrecy="ask" requires your approval.`,
      };
    }
    return {
      disposition: "blocked", category: sensitive.category, page: sensitive.page,
      reason: `Reading page contents is blocked on this ${sensitive.category} page (browserSecrecy=${level}) to keep secrets out of tool results and logs.`,
    };
  }
  if (level === "lockdown" && SECRET_READING_ACTIONS.has(action)) {
    return {
      disposition: "blocked", category: sensitive.category, page: sensitive.page,
      reason: `Reading page contents is withheld on this ${sensitive.category} page: browserSecrecy="lockdown" withholds ALL sensitive pages, administration and financial ones included.`,
    };
  }
  if (MUTATING_BROWSER_ACTIONS.has(action) || action === "evaluate") {
    if (level === "open") return { disposition: "allow", category: sensitive.category, page: sensitive.page };
    return {
      disposition: "approval-required", category: sensitive.category, page: sensitive.page,
      reason: `This high-risk browser action targets a ${sensitive.category} page.`,
    };
  }
  return { disposition: "allow", category: sensitive.category, page: sensitive.page };
}

/** Sessions already shown the open-level cloud warning (one per session). */
const warnedSessions = new Set<string>();

/**
 * At browserSecrecy="open", the first time a session's browser call ENDS on a
 * secret-bearing page, the result gets a warning naming where the contents
 * go: a CLOUD-routed provider receives the page as model context; a local
 * model ("ollama"/"local") keeps it on-box (it still lands in local logs),
 * so no warning fires there. Keyed on the post-dispatch URL, not the action:
 * at open the content flows through MANY result shapes — navigate/new_tab/
 * switch_tab landing auto-snapshots, post-mutation snapshots, tab titles —
 * not just the explicit read actions. Returns the warning line to prepend,
 * or null. Marks the session warned only when a warning is actually
 * returned.
 */
export function secrecyOpenWarning(sessionId: string, rawUrl: string): string | null {
  if (browserSecrecyLevel() !== "open") return null;
  const sensitive = classifySensitivePage(rawUrl);
  if (!sensitive || !isSecretBearingCategory(sensitive.category)) return null;
  if (warnedSessions.has(sessionId)) return null;
  let provider = "anthropic";
  try {
    const s = loadSettings() as { provider?: string };
    if (s.provider) provider = String(s.provider).toLowerCase();
  } catch { /* settings unavailable → assume cloud, warn */ }
  if (provider === "ollama" || provider === "local") return null;
  warnedSessions.add(sessionId);
  return `[browserSecrecy=open] Reading this ${sensitive.category} page sends its contents to ${provider} (a cloud model provider) as model context. A local model keeps page contents on-box. Set browserSecrecy to "ask" or "guarded" to gate secret-bearing pages. (Shown once per session.)`;
}
