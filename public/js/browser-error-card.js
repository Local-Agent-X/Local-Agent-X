// Error card for the Browser pane. browser-tab.js delegates load-error
// rendering here (loaded just before it from app.html — same pattern as
// browser-tab-strip.js).
//
//   render(loadError, opts) — paint the error card into #browser-view-anchor,
//     or clear it when loadError is null. opts:
//       viewId  — the selected view (scopes the deny-reason lookup), optional
//       onRetry(url) — invoked by the Retry button with the failed URL
//
// When the failure is Chromium's ERR_BLOCKED_BY_CLIENT (-20) the card asks
// the server for the recorded egress-policy deny (GET /api/browser/deny-reason,
// a non-consuming peek) and shows the policy's reason + recovery hint in place
// of the bare network-stack string. The lookup is best-effort: any failure
// (plain-browser page without apiFetch, server down, nothing recorded) leaves
// the basic card untouched. Styling is inline — app.css stays untouched.
(function () {
	var ERR_BLOCKED_BY_CLIENT = -20;
	// Monotonic paint id: a deny-reason response landing after the card was
	// cleared or repainted for a different failure must not touch the DOM.
	var renderSeq = 0;

	function fetchDenyReason(err, viewId, els, seq) {
		if (err.code !== ERR_BLOCKED_BY_CLIENT || !err.url) return;
		// shared-api.js defines apiFetch as a plain global; guard so a page
		// loaded without it (tests, stripped-down shells) can't crash the card.
		if (typeof apiFetch !== 'function') return;
		var query = '/api/browser/deny-reason?url=' + encodeURIComponent(err.url) +
			(viewId ? '&viewId=' + encodeURIComponent(viewId) : '');
		apiFetch(query).then(function (r) { return r.json(); }).then(function (deny) {
			if (seq !== renderSeq) return; // stale — card cleared or repainted
			if (!deny || !deny.reason) return;
			// The policy's reason replaces the bare Chromium string; the URL line
			// stays so the user still sees what was blocked.
			els.detail.textContent = err.url;
			els.reason.textContent = 'Blocked: ' + deny.reason;
			els.reason.style.display = '';
			if (deny.recovery) {
				els.recovery.textContent = deny.recovery;
				els.recovery.style.display = '';
			}
		}).catch(function () { /* best-effort — the basic card stays */ });
	}

	// opts: { viewId, onRetry(url) }
	function render(loadError, opts) {
		var anchor = document.getElementById('browser-view-anchor');
		if (!anchor) return;
		renderSeq++;
		if (!loadError) {
			if (anchor.dataset.loadError) { anchor.innerHTML = ''; delete anchor.dataset.loadError; }
			return;
		}
		anchor.dataset.loadError = '1';
		anchor.innerHTML = '';
		var box = document.createElement('div');
		box.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;text-align:center';
		var title = document.createElement('div');
		title.style.cssText = 'font-size:.85rem;font-weight:600;color:var(--text)';
		title.textContent = "Can't reach this page";
		var detail = document.createElement('div');
		detail.style.cssText = 'font-family:var(--mono);font-size:.7rem;color:var(--muted);word-break:break-all';
		detail.textContent = (loadError.url || '') +
			(loadError.description ? ' — ' + loadError.description : '') +
			(typeof loadError.code === 'number' ? ' (' + loadError.code + ')' : '');
		// Deny-reason slots, hidden until the peek comes back with a hit.
		var reason = document.createElement('div');
		reason.id = 'browser-load-error-reason';
		reason.style.cssText = 'font-size:.75rem;color:var(--text);display:none';
		var recovery = document.createElement('div');
		recovery.id = 'browser-load-error-recovery';
		recovery.style.cssText = 'font-size:.7rem;color:var(--muted);display:none';
		var btn = document.createElement('button');
		btn.className = 'artifact-filter';
		btn.id = 'browser-load-error-retry';
		btn.textContent = 'Retry';
		btn.addEventListener('click', function () {
			if (opts && opts.onRetry) opts.onRetry(loadError.url || '');
		});
		box.appendChild(title);
		box.appendChild(detail);
		box.appendChild(reason);
		box.appendChild(recovery);
		box.appendChild(btn);
		anchor.appendChild(box);
		fetchDenyReason(loadError, opts && opts.viewId, { detail: detail, reason: reason, recovery: recovery }, renderSeq);
	}

	window.laxBrowserErrorCard = {
		render: render,
	};
})();
