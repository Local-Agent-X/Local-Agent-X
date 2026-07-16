/**
 * History recorder — funnels canonical `ui:browser` bus events (produced by
 * bridge-perception.ts from desktop UI-activity messages) into the shared
 * BrowserHistoryStore. No new watchers: the ONE existing producer feeds it.
 *
 * Wiring: initHistoryRecorder() is idempotent (same pattern as
 * signals-ui-events.ts wireUiEventBus) and is called at server boot next to
 * initBrowserBridgeClient() in src/server/index.ts — the same lifetime as the
 * bridge listener whose messages become these events.
 *
 * Profile resolution (ACCEPTED SIMPLIFICATION): session-scoped events map to
 * the session's resolved browser profile (session-owner-registry); events
 * with no sessionId — user-driven views — are recorded under "default".
 * A user browsing a `profile-<id>` view therefore lands under "default", not
 * that profile: the bus event's target carries no profile info and the
 * viewId → profile mapping lives desktop-side. Named follow-up, not fixed
 * here.
 *
 * Gating: the recorder checks enableUiEventBus explicitly (same live toggle
 * the ui-event-store enforces), and the producer chain also goes quiet when
 * the toggle is off — belt and braces, and the explicit check makes the
 * behavior testable without the desktop bridge.
 *
 * Agent-tab navigations are NOT yet recorded: the bus only carries
 * user-driven views, and the agent seam (in-app-backend.navigate) is owned
 * by a concurrent chunk. recordAgentVisit() is exported as the ready-made
 * call for that one-line follow-up.
 */

import { EventBus } from "../event-bus.js";
import { createLogger } from "../logger.js";
import { BrowserHistoryStore } from "./history-store.js";
import { resolveSessionBrowserProfileId, DEFAULT_BROWSER_PROFILE_ID } from "./session-owner-registry.js";
import { uiEventBusEnabled } from "../orchestrator/ui-event-store.js";

const logger = createLogger("browser-history-recorder");

let busWired = false;
// Warn ONCE on store write failure — a full disk must not spam the log (and
// must never throw into the bus handler; EventBus isolates listeners, but a
// history hiccup is not worth even an error line per navigation).
let warnedWriteFailure = false;

function profileIdFor(sessionId: unknown): string {
  return typeof sessionId === "string" && sessionId.trim() !== ""
    ? resolveSessionBrowserProfileId(sessionId)
    : DEFAULT_BROWSER_PROFILE_ID;
}

function warnOnce(e: unknown): void {
  if (warnedWriteFailure) return;
  warnedWriteFailure = true;
  logger.warn(`history write failed — recording disabled until it recovers: ${(e as Error).message}`);
}

// Kept as a named handler so a test re-wire can DETACH the previous
// subscription first — wiring must never stack listeners.
const busHandler = (data: unknown): void => {
  if (!uiEventBusEnabled()) return;
  if (typeof data !== "object" || data === null) return;
  const e = data as Record<string, unknown>;
  if (e.surface !== "browser" || typeof e.target !== "string" || e.target === "") return;
  try {
    const store = BrowserHistoryStore.getInstance();
    if (e.action === "navigate") {
      // The store's privacy law redacts/drops the url — the recorder never
      // pre-filters beyond shape checks.
      store.recordVisit(profileIdFor(e.sessionId), e.target);
    } else if (e.action === "title") {
      store.touchTitle(profileIdFor(e.sessionId), e.target);
    }
  } catch (err) {
    warnOnce(err);
  }
};

/** Idempotent — safe to call from any boot path; only the first call binds. */
export function initHistoryRecorder(): void {
  if (busWired) return;
  busWired = true;
  EventBus.on("ui:browser", busHandler);
}

/** Re-arm in tests (also after EventBus.reset() drops the live instance).
 *  Detaches before re-attaching so repeated calls can't stack listeners. */
export function _rewireHistoryRecorderForTest(): void {
  EventBus.off("ui:browser", busHandler);
  busWired = false;
  warnedWriteFailure = false;
  initHistoryRecorder();
}

/**
 * Record an agent-driven navigation directly (no bus hop — agent navigations
 * don't emit ui:browser events). NOT yet called anywhere: the call site is
 * in-app-backend.navigate, owned by a concurrent chunk — this export is the
 * named follow-up seam. Same warn-once, never-throw posture as the bus path.
 */
export function recordAgentVisit(profileId: string, url: string, title = ""): void {
  try {
    BrowserHistoryStore.getInstance().recordVisit(profileId || DEFAULT_BROWSER_PROFILE_ID, url, title);
  } catch (err) {
    warnOnce(err);
  }
}
