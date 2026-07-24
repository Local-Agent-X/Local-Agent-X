// Binds the browser panel to the active chat session: on chat switch it
// surfaces that chat's own agent view, and it re-surfaces one that appears
// later (agent opens a page mid-chat). Kept out of browser-tab.js (size
// ceiling); drives the panel only through laxBrowserTab's public API. The
// views-changed re-check is invoked by browser-tab.js's single pool handler
// (after refreshSwitcher, so the selection is already reconciled) — one hook,
// no race.
(function () {
	var bridge = (window.desktop && window.desktop.browser) || null;
	var boundSessionId = null;

	// A session owns every view id prefixed view-<sessionId>- (base view + tabs).
	function belongsToSession(viewId, sid) {
		return !!viewId && !!sid && viewId.indexOf('view-' + sid + '-') === 0;
	}

	// Surface the bound session's view — but only when the current selection
	// belongs to a DIFFERENT session, so switching among a chat's own tabs (or
	// an agent opening a new tab in the focused chat) is never yanked back.
	function apply(views) {
		var tab = window.laxBrowserTab || null;
		if (!boundSessionId || !bridge || !bridge.switchView || !tab ||
			!tab.getSelectedViewId || !tab.switchTo || !Array.isArray(views)) return;
		if (belongsToSession(tab.getSelectedViewId(), boundSessionId)) return;
		for (var i = 0; i < views.length; i++) {
			if (belongsToSession(views[i].viewId, boundSessionId)) { tab.switchTo(views[i].viewId); return; }
		}
		// No view for this chat yet — leave the panel as-is; a later views-changed
		// (agent opens a page) re-runs this and surfaces it.
	}

	// Called on chat switch (app-sidebar-actions.js). null clears the binding.
	function bindSession(sessionId) {
		boundSessionId = sessionId || null;
		if (!boundSessionId || !bridge || !bridge.listViews) return;
		Promise.resolve(bridge.listViews()).then(apply).catch(function () {});
	}

	window.laxBrowserSessionBind = { bindSession: bindSession, apply: apply };
})();
