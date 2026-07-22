// Find-in-page + per-view zoom for the Browser pane. browser-tab.js notifies
// selection changes via window.laxBrowserFind.onViewSelected (same
// state-owner/helper split as browser-tab-strip.js). This module owns:
//
//   - The find bar: a NORMAL-FLOW row inserted between the toolbar and
//     #browser-view-anchor. It must not overlay the anchor — the page is a
//     native WebContentsView painted ABOVE all DOM (an overlaying bar would be
//     invisible) and any DOM covering the anchor trips the occlusion probe,
//     which would hide the whole page. A flow row shrinks the anchor instead;
//     the ResizeObserver in browser-tab.js re-reports the rect.
//   - Renderer-side hotkeys: Ctrl/Cmd+F opens the bar while the pane is
//     visible; Esc closes it and stops the find (clearSelection). When focus
//     is INSIDE the page itself, main mirrors both keys via the view's
//     before-input-event and pushes browser-find-hotkey / browser-find-closed
//     (browser-page-controls.ts).
//   - The per-view zoom map: session-only presentation state (drag-order
//     precedent), keyed by viewId, fed by browser-zoom-changed pushes (which
//     also carry zoom applied main-side via in-page Ctrl+±) and reapplied on
//     every view switch — Electron persists zoom per-origin per-partition, so
//     without the reapply one view's zoom would leak into a sibling on the
//     same site. Never persisted to disk.
//
// Plain browser (no window.desktop.browser): no hotkey registration, no bar,
// no crash — every entry point no-ops.
(function () {
	var bridge = (window.desktop && window.desktop.browser) || null;
	// Old installed-app preloads may predate these methods — feature-detect so
	// a stale bridge degrades to "no find UI / no zoom UI" instead of throwing.
	var findSupported = !!(bridge && bridge.findStart);
	var zoomSupported = !!(bridge && bridge.setZoom);
	var selectedViewId = null;
	var zoomByView = {}; // viewId -> factor; session-only, never persisted
	var barOpen = false;
	var lastQuery = '';

	var ZOOM_MIN = 0.25, ZOOM_MAX = 3, ZOOM_STEP = 0.1;

	function paneVisible() {
		var body = document.getElementById('browser-tab-body');
		if (!body || body.style.display === 'none') return false;
		var panel = document.getElementById('agent-feeds');
		return !!panel && !panel.classList.contains('collapsed');
	}

	function bar() { return document.getElementById('browser-find-bar'); }

	function setCount(text) {
		var c = document.getElementById('browser-find-count');
		if (c) c.textContent = text;
	}

	function next() { if (lastQuery && findSupported) bridge.findNext(lastQuery); }
	function prev() { if (lastQuery && findSupported) bridge.findPrev(lastQuery); }

	function ensureBar() {
		var el = bar();
		if (el) return el;
		var body = document.getElementById('browser-tab-body');
		var anchor = document.getElementById('browser-view-anchor');
		if (!body || !anchor) return null;
		el = document.createElement('div');
		el.id = 'browser-find-bar';
		el.className = 'browser-find-bar';
		el.style.display = 'none';
		el.innerHTML =
			'<input id="browser-find-input" type="text" placeholder="Find in page" spellcheck="false" autocomplete="off" aria-label="Find in page">' +
			'<span id="browser-find-count" class="browser-find-count"></span>' +
			'<button id="browser-find-prev" class="artifact-filter" title="Previous match (Shift+Enter)">&#8593;</button>' +
			'<button id="browser-find-next" class="artifact-filter" title="Next match (Enter)">&#8595;</button>' +
			'<button id="browser-find-close" class="artifact-filter" title="Close (Esc)">&#10005;</button>';
		body.insertBefore(el, anchor);
		var input = el.querySelector('#browser-find-input');
		input.addEventListener('input', function () {
			lastQuery = input.value;
			if (lastQuery) bridge.findStart(lastQuery);
			else { bridge.findStop(); setCount(''); }
		});
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
			else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
		});
		el.querySelector('#browser-find-prev').addEventListener('click', prev);
		el.querySelector('#browser-find-next').addEventListener('click', next);
		el.querySelector('#browser-find-close').addEventListener('click', function () { close(true); });
		return el;
	}

	function open() {
		if (!findSupported) return;
		var el = ensureBar();
		if (!el) return;
		el.style.display = '';
		barOpen = true;
		var input = document.getElementById('browser-find-input');
		if (input) {
			input.focus();
			input.select();
			// Re-run a kept query so highlights return on reopen.
			if (input.value) { lastQuery = input.value; bridge.findStart(lastQuery); }
		}
	}

	// stop=false → main already stopped the find (its in-page Esc path pushed
	// browser-find-closed); only the UI needs to drop.
	function close(stop) {
		var el = bar();
		if (el) el.style.display = 'none';
		if (barOpen && stop && findSupported) bridge.findStop();
		barOpen = false;
		setCount('');
	}

	function clampZoom(f) {
		return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(f * 100) / 100));
	}

	function currentFactor() {
		return (selectedViewId && zoomByView[selectedViewId]) || 1;
	}

	function zoomLabel() {
		var btn = document.getElementById('browser-zoom-reset');
		if (btn) btn.textContent = Math.round(currentFactor() * 100) + '%';
	}

	// Toolbar −/%/+ cluster (app.html). Main clamps + echoes the applied
	// factor back via browser-zoom-changed; the local write just keeps the
	// label responsive between click and echo.
	function zoomStep(dir) {
		if (!zoomSupported) return;
		var f = dir === 'reset' ? 1 : clampZoom(currentFactor() + (dir === 'in' ? ZOOM_STEP : -ZOOM_STEP));
		if (selectedViewId) zoomByView[selectedViewId] = f;
		bridge.setZoom(f);
		zoomLabel();
	}

	function onViewSelected(viewId) {
		if (!viewId || viewId === selectedViewId) return;
		selectedViewId = viewId;
		// A find session belongs to the OLD view's page — close the bar and
		// stop it (main's find-stop clears the session wherever it lives).
		if (barOpen) close(true);
		if (zoomSupported) {
			var f = zoomByView[viewId] || 1;
			zoomByView[viewId] = f;
			bridge.setZoom(f); // reapply: per-origin zoom leaks across same-partition views
			zoomLabel();
		}
	}

	function init() {
		if (!bridge) return; // plain browser: no hotkey, no bar
		if (findSupported) {
			document.addEventListener('keydown', function (e) {
				// Superseded-instance guard: if this module was re-injected the old
				// document listener must go inert instead of double-driving the bar.
				if (window.laxBrowserFind !== api) return;
				if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
					(e.key === 'f' || e.key === 'F')) {
					if (!paneVisible()) return; // Ctrl+Shift+F (global search) untouched
					e.preventDefault();
					open();
				} else if (e.key === 'Escape' && barOpen) {
					close(true);
				}
			});
			if (bridge.onFoundInPage) bridge.onFoundInPage(function (r) {
				if (!r || !barOpen) return;
				if (selectedViewId && r.viewId !== selectedViewId) return; // background view's results
				setCount(r.matches ? (r.activeMatchOrdinal + '/' + r.matches) : '0/0');
			});
			if (bridge.onFindHotkey) bridge.onFindHotkey(function () { if (paneVisible()) open(); });
			if (bridge.onFindClosed) bridge.onFindClosed(function () { close(false); });
		}
		if (zoomSupported && bridge.onZoomChanged) bridge.onZoomChanged(function (info) {
			if (!info || !info.viewId) return;
			zoomByView[info.viewId] = info.factor;
			if (info.viewId === selectedViewId) zoomLabel();
		});
	}

	var api = {
		open: open,
		close: function () { close(true); },
		zoomStep: zoomStep,
		onViewSelected: onViewSelected,
		onPaneHidden: function () { close(true); },
	};
	window.laxBrowserFind = api;

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
})();
