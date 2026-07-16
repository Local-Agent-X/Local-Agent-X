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
			document.visibilityState === 'visible';
	}

	// DOM overlays (global search, shortcuts help, modals, dropdown menus)
	// would render UNDER the native view unless it hides — hit-test the
	// anchor's center AND four inset corners: full-screen overlays cover the
	// center, but a dropdown (e.g. the titlebar ⋯ menu) only drapes over a
	// corner of the pane and a center-only probe misses it, leaving the menu
	// stuck behind the page. Any probe resolving outside the anchor means
	// occluded. The inset keeps corner probes off adjacent chrome (the 5px
	// panel resize handle overlaps the pane's left edge); a null hit (no
	// layout info) is treated as unoccluded rather than flapping the view off.
	function anchorOccluded(anchor, rect) {
		if (typeof document.elementFromPoint !== 'function') return false;
		var inset = 12;
		var points = [
			[rect.left + rect.width / 2, rect.top + rect.height / 2],
			[rect.left + inset, rect.top + inset],
			[rect.left + rect.width - inset, rect.top + inset],
			[rect.left + inset, rect.top + rect.height - inset],
			[rect.left + rect.width - inset, rect.top + rect.height - inset],
		];
		for (var i = 0; i < points.length; i++) {
			var hit = document.elementFromPoint(points[i][0], points[i][1]);
			if (hit && hit !== anchor && !anchor.contains(hit)) return true;
		}
		return false;
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

	// ── Multi-view switcher ─────────
	// The pool may hold several views: the user's own foreground view plus any
	// agent-driven per-(session,profile) views. The switcher lists them all and
	// flips which one the anchor drives/shows; background views stay live.

	function switcherLabel(v) {
		var name = v.profileId || 'view';
		return (v.agentDriven ? '🤖 ' : '') + name;
	}

	function renderSwitcher(views) {
		var slot = document.getElementById('browser-view-switcher-slot');
		if (!slot) return;
		// One view (or none) → no switcher clutter.
		if (!views || views.length <= 1) { slot.innerHTML = ''; return; }
		slot.innerHTML = '';
		slot.style.display = 'flex';
		slot.style.gap = '4px';
		for (var i = 0; i < views.length; i++) {
			(function (v) {
				var pill = document.createElement('button');
				pill.className = 'artifact-filter' + (v.viewId === selectedViewId ? ' active' : '');
				pill.textContent = switcherLabel(v);
				pill.title = v.viewId + (v.url ? ('\n' + v.url) : '') +
					(v.agentDriven ? '\n(agent-driven)' : '');
				pill.setAttribute('data-view-id', v.viewId);
				pill.addEventListener('click', function () { switchTo(v.viewId); });
				slot.appendChild(pill);
			})(views[i]);
		}
	}

	function refreshSwitcher() {
		if (!bridge || !bridge.listViews) return Promise.resolve();
		return Promise.resolve(bridge.listViews()).then(function (views) {
			// Adopt the attached view as selected if we don't have one yet (first
			// paint, before any user switch or nav-state push).
			if (selectedViewId == null && views && views.length) {
				var attached = null;
				for (var i = 0; i < views.length; i++) if (views[i].attached) { attached = views[i].viewId; break; }
				selectedViewId = attached || views[0].viewId;
			}
			renderSwitcher(views);
			return views;
		}).catch(swallow);
	}

	function switchTo(viewId) {
		if (!bridge || !bridge.switchView) return;
		selectedViewId = viewId; // optimistic — pill highlights immediately
		Promise.resolve(bridge.switchView(viewId)).then(function (state) {
			if (state) updateNavUI(state);
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

	function updateNavUI(state) {
		if (!state) return;
		// Tagged nav-state: only the currently shown view drives the address bar.
		// Adopt the first view we hear about if nothing is selected yet.
		if (state.viewId) {
			if (selectedViewId == null) selectedViewId = state.viewId;
			if (state.viewId !== selectedViewId) return;
		}
		var input = document.getElementById('browser-url-input');
		var back = document.getElementById('browser-nav-back');
		var fwd = document.getElementById('browser-nav-fwd');
		var reload = document.getElementById('browser-nav-reload');
		// Don't clobber the URL the user is mid-typing.
		if (input && document.activeElement !== input) input.value = state.url || '';
		if (back) back.disabled = !state.canGoBack;
		if (fwd) fwd.disabled = !state.canGoForward;
		if (reload) reload.title = state.loading ? 'Loading…' : 'Reload';
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
		onTabHidden: function () { tabShown = false; sync(); stopSwitcherPolling(); },
		sync: sync,
		goBack: function () { if (bridge) bridge.goBack(); },
		goForward: function () { if (bridge) bridge.goForward(); },
		reload: function () { if (bridge) bridge.reload(); },
		navigateFromInput: navigateFromInput,
		// Exposed for the switcher test + programmatic refresh.
		refreshSwitcher: refreshSwitcher,
		switchTo: switchTo,
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
})();
