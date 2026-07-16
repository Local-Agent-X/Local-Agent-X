// ── UI-events cognitive signal ── surfaces a short digest of recent
// user-interface activity (in-app browser first) as agent context.
//
// This module owns two things:
//   1. The ONE event-bus subscription that funnels `ui:*` events into the
//      per-session ring buffers (ui-event-store.ts). Wired once at module
//      init — the registry imports this file, so any orchestrator boot
//      registers exactly one listener.
//   2. The "ui-events" registry entry: when a session has undigested
//      activity, run() emits ONE ModuleSignal carrying the digest, then
//      advances the freshness cursor so the same activity is never
//      re-injected on later turns.
//
// Gated end-to-end by the enableUiEventBus toggle (Settings → Security):
// off ⇒ the store buffers nothing and triage never activates this module.

import { EventBus } from "../event-bus.js";
import type { CognitiveSignal } from "./types.js";
import {
  advanceDigestTs,
  digestSince,
  getLastDigestTs,
  hasFreshUiEvents,
  recordUiEvent,
  uiEventBusEnabled,
  uiEventStoreHealth,
  type UiEvent,
} from "./ui-event-store.js";

let busWired = false;

/** Idempotent — safe to call from any boot path; only the first call binds. */
export function wireUiEventBus(): void {
  if (busWired) return;
  busWired = true;
  // Bus payloads are untyped; the store's sanitizer is the schema authority
  // and rejects/strips anything that doesn't conform.
  EventBus.on("ui:*", data => recordUiEvent(data as UiEvent));
}

/** Re-arm after EventBus.reset() in tests (reset drops the live instance). */
export function _rewireUiEventBusForTest(): void {
  busWired = false;
  wireUiEventBus();
}

wireUiEventBus();

export const uiEventSignals: CognitiveSignal[] = [
  {
    id: "ui-events",
    // "profile" scope, deliberately: cross-session bleed is prevented
    // STRUCTURALLY by the store (a session's ring is only readable by that
    // session; the global scope is shared by design), and the digest is
    // ambient "what the user is doing right now" context that must survive
    // short follow-ups ("ok, log in") where the session-scope bleed gate
    // would drop it.
    scope: "profile",
    triage: ({ input }) =>
      uiEventBusEnabled() && hasFreshUiEvents(input.sessionId) ? "conditional" : null,
    run: (input, out) => {
      if (!uiEventBusEnabled()) return;
      const digest = digestSince(input.sessionId, getLastDigestTs(input.sessionId));
      if (!digest) return;
      out.push({
        source: "ui-events",
        signal: digest.text,
        // Mid-band: high enough to survive mergeSignals' top-7 slice on a
        // quiet turn, below the 8-10 veto/critical band (vulnerability).
        priority: 5,
        // "recall" renders in buildParagraph's contextual bucket.
        category: "recall",
        confidence: 0.9,
      });
      advanceDigestTs(input.sessionId, digest.latestTs);
    },
    health: () => uiEventStoreHealth(),
  },
];
