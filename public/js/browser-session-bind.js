// Binds the browser panel to the active chat session: on chat switch it
// surfaces that chat's own agent view, and it surfaces one that appears later
// (agent opens a page mid-chat). Between those, a tab the user picks stays
// picked: every switch pokes views-changed, so re-surfacing on every poke
// snapped a click on another tab (a PDF the panel already had open) straight
// back to the chat's view. Kept out of browser-tab.js (size
// ceiling); drives the panel only through laxBrowserTab's public API. The
// views-changed re-check is invoked by browser-tab.js's single pool handler
// (after refreshSwitcher, so the selection is already reconciled) — one hook,
// no race.
(function () {
	var bridge = (window.desktop && window.desktop.browser) || null;
	var boundSessionId = null;
	// The bound session's view ids as of the last apply; null until the first
	// apply after a bind, when every view of the session counts as new.
	var knownViewIds = null;

	// A session owns every view id prefixed view-<sessionId>- (base view + tabs).
	function belongsToSession(viewId, sid) {
		return !!viewId && !!sid && viewId.indexOf('view-' + sid + '-') === 0;
	}

	// Surface a view of the bound session that is new since the last apply
	// (all of them, right after a bind) — and only when the current selection
	// belongs to a DIFFERENT session, so switching among a chat's own tabs (or
	// an agent opening a new tab in the focused chat) is never yanked back.
	function apply(views) {
		var tab = window.laxBrowserTab || null;
		if (!boundSessionId || !bridge || !bridge.switchView || !tab ||
			!tab.getSelectedViewId || !tab.switchTo || !Array.isArray(views)) return;
		var mine = [];
		for (var i = 0; i < views.length; i++) {
			if (views[i] && belongsToSession(views[i].viewId, boundSessionId)) mine.push(views[i].viewId);
		}
		var known = knownViewIds;
		var fresh = known ? mine.filter(function (id) { return known.indexOf(id) === -1; }) : mine;
		knownViewIds = mine;
		// No new view for this chat — leave the panel as-is; a later views-changed
		// (agent opens a page) re-runs this and surfaces it.
		if (!fresh.length || belongsToSession(tab.getSelectedViewId(), boundSessionId)) return;
		tab.switchTo(fresh[0]);
	}

	// Called on chat switch (app-sidebar-actions.js). null clears the binding.
	function bindSession(sessionId) {
		boundSessionId = sessionId || null;
		knownViewIds = null;
		if (!boundSessionId || !bridge || !bridge.listViews) return;
		Promise.resolve(bridge.listViews()).then(apply).catch(function () {});
	}

	window.laxBrowserSessionBind = { bindSession: bindSession, apply: apply };
})();
