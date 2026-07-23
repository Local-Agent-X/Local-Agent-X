// Browser tab in the right sidebar. The actual page is NOT rendered here —
// it's a native WebContentsView overlay drawn by Electron main on top of
// this window. This module only:
//   1. reserves space (#browser-view-anchor) and reports its rect to main
//      via window.desktop.browser.setBounds,
//   2. decides visibility (tab shown + panel not collapsed + document
//      visible + anchor not occluded by a DOM overlay → show, else hide)
//      via setVisible,
//   3. drives navigation (address bar + back/fwd/reload) and mirrors
//      main's nav-state pushes back into the UI.
// In a plain browser (no window.desktop.browser) the pane shows a
// desktop-only placeholder and everything else no-ops.
//
// chat-artifacts.js calls window.laxBrowserTab.onTabShown()/onTabHidden()
// from switchSidePanelTab.

(function () {
	var bridge = (window.desktop && window.desktop.browser) || null;
	var tabShown = false;
	var lastVisible = null; // dedup setVisible IPC; null = never sent
	var lastBoundsKey = null; // dedup setBounds IPC
	// Multi-view switcher state. selectedViewId is the view whose nav-state fills
	// the address bar (and the highlighted pill); it follows the user's switches
	// and adopts the first view main reports. switcherTimer polls the pool for
	// new/closed views (e.g. an agent spinning up a per-profile view) only while
	// the tab is actually shown — no background polling.
	var selectedViewId = null;
	var switcherTimer = null;
	var SWITCHER_POLL_MS = 2000;
	// Last main-frame load failure of the SELECTED view (from nav-state), or
	// null. While set, the native view hides and the anchor renders an error
	// card — without this a dead local server is just a silent white pane.
	var loadError = null;
	// True while the SELECTED view is mid-load — the toolbar ↻ becomes ✕/Stop.
	var selectedLoading = false;

	function panelCollapsed() {
		var panel = document.getElementById('agent-feeds');
		return !panel || panel.classList.contains('collapsed');
	}

	// Visibility rule: the native overlay may only be visible while the
	// Browser tab is the active tab AND the side panel is open AND the
	// document is visible (minimize/hidden-tab flips visibilityState to
	// "hidden", which covers "hide on blur only when minimized" — plain
	// blur keeps the page visible so co-drive works while unfocused).
	function shouldShow() {
		return !!bridge && tabShown && !panelCollapsed() &&
			document.visibilityState === 'visible' && !loadError;
	}

	// Occlusion probe grid — extracted to browser-occlusion.js (loaded just
	// before this file, same pattern as browser-error-card.js). Missing script
	// → treat as unoccluded.
	function anchorOccluded(anchor, rect) {
		var occ = window.laxBrowserOcclusion || null;
		return !!occ && occ.anchorOccluded(anchor, rect);
	}

	// Selection changed → tell the find/zoom module (browser-find.js) so it
	// drops a stale find session and reapplies the view's stored zoom factor.
	function noteViewSelected(viewId) {
		if (window.laxBrowserFind && viewId) window.laxBrowserFind.onViewSelected(viewId);
	}

	// IPC invokes can reject during shutdown races (bridge torn down while a
	// sync is in flight) — swallow instead of unhandled-rejection noise.
	function swallow() {}

	function sync() {
		if (!bridge) return;
		var visible = shouldShow();
		var rect = null;
		if (visible) {
			var anchor = document.getElementById('browser-view-anchor');
			rect = anchor ? anchor.getBoundingClientRect() : null;
			// A zero-size anchor (mid-layout, display:none race) means there is
			// nowhere to draw — hide rather than report degenerate 0-bounds.
			if (!rect || rect.width < 1 || rect.height < 1) visible = false;
			else if (anchorOccluded(anchor, rect)) visible = false;
		}
		if (visible && rect) {
			// Rect is (zoom-scaled) CSS px relative to the viewport; main
			// converts it to window DIPs with the current content zoom factor
			// (browser-ipc.ts). Only report changed bounds — the body-wide
			// observer re-runs sync on unrelated DOM churn.
			var key = Math.round(rect.left) + ',' + Math.round(rect.top) + ',' +
				Math.round(rect.width) + ',' + Math.round(rect.height);
			if (key !== lastBoundsKey) {
				lastBoundsKey = key;
				Promise.resolve(bridge.setBounds({
					x: Math.round(rect.left),
					y: Math.round(rect.top),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				})).catch(swallow);
			}
		}
		if (visible !== lastVisible) {
			Promise.resolve(bridge.setVisible(visible)).catch(swallow);
			lastVisible = visible;
		}
	}

	// Observer callbacks coalesce into one sync per frame — the body-wide
	// mutation observer would otherwise sync on every streamed chat chunk.
	var syncQueued = false;
	function scheduleSync() {
		if (syncQueued) return;
		syncQueued = true;
		var raf = window.requestAnimationFrame || function (cb) { setTimeout(cb, 16); };
		raf(function () { syncQueued = false; sync(); });
	}

	// ── Multi-view tab strip ─────────
	// The pool may hold several views: the user's own foreground view plus any
	// agent-driven per-(session,profile) views. Rendering + selection
	// reconciliation live in browser-tab-strip.js (window.laxBrowserTabStrip,
	// loaded just before this file); this module owns the state and the bridge.

	function refreshSwitcher() {
		if (!bridge || !bridge.listViews) return Promise.resolve();
		return Promise.resolve(bridge.listViews()).then(function (views) {
			var strip = window.laxBrowserTabStrip || null;
			if (!strip) return views; // strip script missing → no UI, state intact
			// Follow main's retargets: on first paint adopt the attached (or
			// first) view; afterwards, if main auto-surfaced a different view
			// (attached flipped under us), re-adopt it and refill the nav UI
			// from its pool entry — otherwise the address bar + active pill
			// keep naming the OLD view while back/fwd/reload drive the new one.
			var adopted = strip.reconcileSelection(views, selectedViewId);
			if (adopted) {
				var changed = adopted.viewId !== selectedViewId;
				var readopt = selectedViewId != null && changed;
				selectedViewId = adopted.viewId;
				if (changed) noteViewSelected(adopted.viewId);
				// updateNavUI's activeElement guard keeps a mid-typed URL intact.
				if (readopt) {
					updateNavUI({ viewId: adopted.viewId, url: adopted.url || '' });
					// The pool entry has no history state, and an IDLE view never
					// pushes another nav-state — without this fetch, back/fwd stay
					// wrongly disabled until the next navigation event. Main's
					// currentViewId is already retargeted, so getNavState() is
					// the full state of exactly this view.
					if (bridge.getNavState) {
						Promise.resolve(bridge.getNavState()).then(function (state) {
							if (state && state.viewId === selectedViewId) updateNavUI(state);
						}).catch(swallow);
					}
				}
			}
			strip.render(views, {
				slot: document.getElementById('browser-view-switcher-slot'),
				selectedViewId: selectedViewId,
				onSelect: switchTo,
				onNewTab: newTab,
				// Only offer ✕ when the bridge can actually close (real desktop);
				// a bridge without closeView renders pills unchanged.
				onClose: (bridge.closeView ? closeTab : null),
			});
			return views;
		}).catch(swallow);
	}

	// ✕ on a pill: close the view main-side, then re-list. Main retargets the
	// anchor to the foreground view when the closed tab was the current one, so
	// we just drop our selection and let refreshSwitcher re-adopt whatever is
	// attached. Agent views close recoverably — main tells the server child so
	// the owning backend recreates the view on the agent's next op.
	function closeTab(viewId) {
		if (!bridge || !bridge.closeView) return;
		Promise.resolve(bridge.closeView(viewId)).then(function (closed) {
			if (closed && selectedViewId === viewId) selectedViewId = null;
			refreshSwitcher();
		}).catch(swallow);
	}

	function switchTo(viewId) {
		if (!bridge || !bridge.switchView) return;
		selectedViewId = viewId; // optimistic — pill highlights immediately
		Promise.resolve(bridge.switchView(viewId)).then(function (state) {
			// Notify AFTER the switch settles: the find/zoom module reapplies the
			// stored zoom via the command surface, which acts on main's (now
			// switched) current view.
			if (state) { updateNavUI(state); noteViewSelected(viewId); }
			refreshSwitcher();
		}).catch(swallow);
	}

	// "+" button: mint a fresh user tab, adopt it, and mirror its nav state.
	// An optional url loads immediately in the new tab (chat-link-open.js);
	// the strip's "+" click handler passes no argument, and a stray event
	// object must not become a load target.
	function newTab(url) {
		if (!bridge || !bridge.newTab) return;
		var target = (typeof url === 'string' && url) ? url : undefined;
		Promise.resolve(bridge.newTab(target)).then(function (state) {
			if (state) {
				selectedViewId = state.viewId;
				updateNavUI(state);
				noteViewSelected(state.viewId);
			}
			refreshSwitcher();
		}).catch(swallow);
	}

	function startSwitcherPolling() {
		if (switcherTimer || !bridge || !bridge.listViews) return;
		switcherTimer = setInterval(refreshSwitcher, SWITCHER_POLL_MS);
		refreshSwitcher();
	}

	function stopSwitcherPolling() {
		if (switcherTimer) { clearInterval(switcherTimer); switcherTimer = null; }
	}

	// Error card in the anchor while the selected view's last load failed. The
	// native view is hidden by shouldShow() so the card is actually visible.
	// Rendering — including the deny-reason lookup for egress-blocked loads —
	// lives in browser-error-card.js (window.laxBrowserErrorCard, loaded just
	// before this file); this module owns the state and the retry action.
	function renderLoadError() {
		var card = window.laxBrowserErrorCard || null;
		if (!card) return; // card script missing → no card, state intact
		card.render(loadError, {
			viewId: selectedViewId,
			// Retry re-navigates to the failed URL — reload() on a navigation
			// that never committed can no-op.
			onRetry: function (url) {
				if (!bridge) return;
				if (url) bridge.navigate(url);
				else bridge.reload();
			},
		});
	}

	function updateNavUI(state) {
		if (!state) return;
		// Tagged nav-state: only the currently shown view drives the address bar.
		// Adopt the first view we hear about if nothing is selected yet.
		if (state.viewId) {
			if (selectedViewId == null) { selectedViewId = state.viewId; noteViewSelected(state.viewId); }
			// Per-pill spinner: EVERY tagged push feeds the strip (background views
			// load too), so this runs before the selected-view filter below.
			var strip = window.laxBrowserTabStrip;
			if (strip && strip.noteNavState) strip.noteNavState(state);
			if (state.viewId !== selectedViewId) return;
		}
		// Failure state: track it, repaint the card, and re-run the visibility
		// rule (the native view hides while the card is up, returns on recovery).
		var err = state.loadError || null;
		var errKey = err ? err.url + '|' + err.code : '';
		var prevKey = loadError ? loadError.url + '|' + loadError.code : '';
		if (errKey !== prevKey) {
			loadError = err;
			renderLoadError();
			sync();
		}
		var input = document.getElementById('browser-url-input');
		var back = document.getElementById('browser-nav-back');
		var fwd = document.getElementById('browser-nav-fwd');
		var reload = document.getElementById('browser-nav-reload');
		// Don't clobber the URL the user is mid-typing.
		if (input && document.activeElement !== input) input.value = state.url || '';
		if (back) back.disabled = !state.canGoBack;
		if (fwd) fwd.disabled = !state.canGoForward;
		// Selected view loading + bridge.stop → ↻ flips to ✕ (click = stop, see
		// the reload export); an OLD bridge without stop keeps the Loading… title.
		selectedLoading = !!state.loading && !state.loadError;
		var stoppable = selectedLoading && !!(bridge && bridge.stop);
		if (reload) { reload.textContent = stoppable ? '✕' : '↻'; reload.title = stoppable ? 'Stop' : (state.loading ? 'Loading…' : 'Reload'); }
	}

	function navigateFromInput() {
		if (!bridge) return;
		var input = document.getElementById('browser-url-input');
		if (!input) return;
		var url = (input.value || '').trim();
		if (!url) return;
		// Bare hostnames get https:// — anything with an explicit scheme
		// (https:, http:, about:, …) passes through untouched.
		if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
		input.value = url;
		bridge.navigate(url);
	}

	function showPlaceholder() {
		var anchor = document.getElementById('browser-view-anchor');
		if (anchor) {
			anchor.innerHTML = '<div class="artifacts-empty">Browser is available in the desktop app only</div>';
		}
		var bar = document.getElementById('browser-address-bar');
		if (bar) bar.style.display = 'none';
	}

	function init() {
		if (!bridge) {
			showPlaceholder();
			return;
		}
		var input = document.getElementById('browser-url-input');
		if (input) {
			input.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') { e.preventDefault(); navigateFromInput(); }
			});
		}
		bridge.onNavState(updateNavUI);
		Promise.resolve(bridge.getNavState()).then(updateNavUI).catch(function () {});
		// Pool-change poke (create/close/attach-flip, incl. main auto-surfacing
		// an agent view): re-list immediately — refreshSwitcher also re-adopts
		// the attached view. The 2s poll below stays as fallback while shown.
		if (bridge.onViewsChanged) bridge.onViewsChanged(function () { refreshSwitcher(); });
		// Agent opened a website while the user wasn't watching a real page:
		// bring the Browser tab up so the agent's browsing is visible. Open the
		// right rail if collapsed, then flip it to BROWSER — same seam the local
		// -service-link handler (shared-dom.js) uses. onTabShown attaches the
		// native view, so this is also what makes the retargeted view paint.
		if (bridge.onAgentSurfaced) bridge.onAgentSurfaced(function () {
			if (typeof agentFeedsOpen !== 'undefined' && !agentFeedsOpen &&
				typeof toggleAgentFeeds === 'function') toggleAgentFeeds();
			if (typeof switchSidePanelTab === 'function') switchSidePanelTab('browser');
		});
		refreshSwitcher();
		// Rect changes: panel resize drag, window resize, layout shifts —
		// the ResizeObserver on the anchor catches all of them without
		// touching chat-agent-feeds-resize.js.
		var anchor = document.getElementById('browser-view-anchor');
		if (anchor && typeof ResizeObserver !== 'undefined') {
			new ResizeObserver(scheduleSync).observe(anchor);
		}
		window.addEventListener('resize', scheduleSync);
		if (typeof MutationObserver !== 'undefined') {
			// Panel open/collapse toggles class "collapsed" on #agent-feeds
			// (chat-agent-feeds.js) — observe the class attribute.
			var panel = document.getElementById('agent-feeds');
			if (panel) {
				new MutationObserver(scheduleSync)
					.observe(panel, { attributes: true, attributeFilter: ['class'] });
			}
			// Overlays (global search, shortcuts, agent detail, modals) are
			// appended to / class-toggled under body — watch childList +
			// class/style so open/close re-runs the occlusion probe.
			// rAF-coalesced above, so DOM churn costs one sync per frame.
			new MutationObserver(scheduleSync).observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['class', 'style'],
			});
		}
		// Minimize / hidden window → visibilityState "hidden" → overlay hides.
		document.addEventListener('visibilitychange', sync);
		window.addEventListener('blur', sync);
		window.addEventListener('focus', sync);
	}

	window.laxBrowserTab = {
		onTabShown: function () { tabShown = true; sync(); startSwitcherPolling(); },
		onTabHidden: function () {
			tabShown = false; sync(); stopSwitcherPolling();
			if (window.laxBrowserFind) window.laxBrowserFind.onPaneHidden();
		},
		sync: sync,
		goBack: function () { if (bridge) bridge.goBack(); },
		goForward: function () { if (bridge) bridge.goForward(); },
		// Toolbar ↻/✕ click: stop mid-load (mirrors updateNavUI's flip), else reload.
		reload: function () { if (bridge) { if (selectedLoading && bridge.stop) bridge.stop(); else bridge.reload(); } },
		navigateFromInput: navigateFromInput,
		// Exposed for the switcher/strip tests + programmatic refresh.
		refreshSwitcher: refreshSwitcher,
		switchTo: switchTo,
		newTab: newTab,
		// Chat links (chat-link-open.js): open url as a fresh USER tab and
		// raise the Browser panel so the page is actually visible.
		openUrl: function (url) {
			if (typeof switchSidePanelTab === 'function') switchSidePanelTab('browser');
			newTab(url);
		},
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
})();
