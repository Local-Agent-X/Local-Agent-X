// ── UI-events cognitive signal ── surfaces a short digest of recent
// user-interface activity (in-app browser first) as agent context.
//
// This module owns two things:
//   1. The ONE event-bus subscription that funnels `ui:*` events into the
//      per-session ring buffers (ui-event-store.ts). Wired once at module
//      init — the registry imports this file, so any orchestrator boot
//      registers exactly one listener.
//   2. The "ui-events" registry entry: when a session has activity in the
//      digest window, run() emits ONE ModuleSignal carrying the digest. No
//      cursor: the digest text leads with its variable identity (count +
//      latest-event time), so the pipeline's own hash dedup drops exact
//      repeats, while a digest that a downstream gate cut (bleed gate,
//      top-7 slice, contextual cut) is simply retried on a later turn
//      instead of being lost.
//
// Gated end-to-end by the enableUiEventBus toggle (Settings → Security):
// off ⇒ the store buffers nothing and triage never activates this module.

import { EventBus } from "../event-bus.js";
import type { CognitiveSignal } from "./types.js";
import {
  hasFreshUiEvents,
  recentUiDigest,
  recordUiEvent,
  uiEventBusEnabled,
  uiEventStoreHealth,
  type UiEvent,
} from "./ui-event-store.js";

let busWired = false;
// Kept so a re-wire can DETACH the previous subscription first — wiring must
// never stack listeners (each stacked listener double-records every event).
const busHandler = (data: unknown): void => recordUiEvent(data as UiEvent);

/** Idempotent — safe to call from any boot path; only the first call binds. */
export function wireUiEventBus(): void {
  if (busWired) return;
  busWired = true;
  // Bus payloads are untyped; the store's sanitizer is the schema authority
  // and rejects/strips anything that doesn't conform.
  EventBus.on("ui:*", busHandler);
}

/** Re-arm in tests (also after EventBus.reset() drops the live instance).
 *  Detaches before re-attaching so repeated calls can't stack listeners. */
export function _rewireUiEventBusForTest(): void {
  EventBus.off("ui:*", busHandler);
  busWired = false;
  wireUiEventBus();
}

wireUiEventBus();

export const uiEventSignals: CognitiveSignal[] = [
  {
    id: "ui-events",
    // "profile" scope, deliberately: cross-session bleed is prevented
    // STRUCTURALLY by the store (a session's ring is only readable by that
    // session; the global scope is shared by design). Note the bleed gate's
    // "resume" verdict can still drop the digest for a turn — that costs one
    // retry, not the activity: the window re-digests on the next turn.
    scope: "profile",
    triage: ({ input }) =>
      uiEventBusEnabled() && hasFreshUiEvents(input.sessionId) ? "conditional" : null,
    run: (input, out) => {
      if (!uiEventBusEnabled()) return;
      const digest = recentUiDigest(input.sessionId);
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
    },
    health: () => uiEventStoreHealth(),
  },
];
