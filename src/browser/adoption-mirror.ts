/**
 * Mirrors user-view adoption to the DESKTOP so its trust resolver knows who
 * is driving. The server already attributes an adopted tab's egress to the
 * driving session (bridge-perception adoptedViewSessions → egress worker
 * mirror); without this mirror the desktop's per-partition policies kept
 * treating the view as user-driven — agent-triggered downloads on an adopted
 * tab bypassed quarantine into ~/Downloads (uninspected, unattributed), and
 * the user-loopback carve-out stayed open to the agent.
 *
 * Own module: bridge-client transitively imports bridge-perception (via
 * egress-worker-host), so neither of those can host the subscription without
 * a cycle. Wired once from server startup beside initBrowserBridgeClient().
 * Pushes are fire-and-forget — a headless run has no desktop to mirror to,
 * and a missed push fails SAFE only in one direction (desktop still thinks
 * "adopted" → quarantine), never toward ~/Downloads.
 */
import { browserBridgeAvailable, browserLifecycle } from "./bridge-client.js";
import { subscribeAdoptedViewChanges } from "./bridge-perception.js";

let wired = false;

export function wireAdoptionMirror(): void {
	if (wired) return;
	wired = true;
	subscribeAdoptedViewChanges((viewId, sessionId) => {
		if (!browserBridgeAvailable()) return;
		void browserLifecycle(sessionId ? "adopt" : "release", viewId).catch(() => {
			/* desktop gone mid-push — the replay-on-subscribe contract does not
			   apply here (this subscription lives for the server's lifetime);
			   a vanished desktop rebuilds its pool empty anyway. */
		});
	});
}
