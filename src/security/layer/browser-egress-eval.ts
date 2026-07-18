import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import { evaluateWebFetch, type EgressMode } from "./network-policy.js";

// ── Browser navigation egress pre-flight ──
//
// Extracted from SecurityLayer (layer-core.ts) as pure functions: the `browser`
// tool's navigate/new_tab gate, including the batch (`urls: string[]`)
// deny-wins iteration. The SecurityLayer supplies its runtime egress state via
// BrowserEgressCtx — same idiom as ShellPathGuardCtx in shell-path-guard.ts.
// Decision semantics and reason strings are byte-identical to the pre-split
// class methods; the per-URL policy itself remains network-policy.ts's
// evaluateWebFetch (single source of truth for egress).

export interface BrowserEgressCtx {
  egressAllowlist: ReadonlySet<string>;
  egressAllowlistConfigured: boolean;
  selfPort: string;
  egressMode: EgressMode;
  localServicePorts: ReadonlySet<string>;
  manualHostPorts: ReadonlySet<string>;
}

export function evaluateBrowser(args: Record<string, unknown>, ctx: BrowserEgressCtx): SecurityDecision {
  if (args.action === "navigate" || args.action === "new_tab") {
    // new_tab may carry a batch (`urls: string[]`, which takes precedence over
    // `url`). Pre-check EVERY entry through the same per-URL gate; deny wins.
    // This tool-layer pre-flight is defense-in-depth + consistent early-denial
    // UX — the request-layer per-hop egress guards (CDP installRequestGuard;
    // in-app browser-partition egress-ask) still cover every navigation
    // fail-closed even without it.
    if (Array.isArray(args.urls) && args.urls.length > 0) {
      for (const entry of args.urls) {
        const decision = evaluateBrowserUrl(String(entry), ctx);
        if (!decision.allowed) {
          return { ...decision, reason: `${decision.reason} (url: ${String(entry)})` };
        }
      }
      return { allowed: true, reason: "Browser navigation allowed" };
    }
    if (args.url) return evaluateBrowserUrl(String(args.url), ctx);
  }
  return { allowed: true, reason: "Browser action allowed" };
}

/** Per-URL browser navigation gate: localhost carve-out, then the egress policy. */
export function evaluateBrowserUrl(browserUrl: string, ctx: BrowserEgressCtx): SecurityDecision {
  // Allow localhost/127.0.0.1 for browser — user's own dev servers
  try {
    const host = new URL(browserUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return { allowed: true, reason: "Browser navigation to localhost allowed" };
    }
    return evaluateWebFetch(
      ctx.egressAllowlist,
      ctx.egressAllowlistConfigured,
      ctx.selfPort,
      browserUrl,
      ctx.egressMode,
      ctx.localServicePorts,
      ctx.manualHostPorts,
    );
  } catch {
    return { allowed: false, reason: "Blocked: invalid URL", userHint: USER_HINTS.network };
  }
}
