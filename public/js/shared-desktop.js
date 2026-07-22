// Desktop-only: surface a server crash (OOM / SIGKILL / nonzero exit) instead
// of letting the UI dangle on a dead SSE stream forever. Fires a native macOS
// notification AND a DOM event so any panel listening (e.g. chat-send) can
// clear stuck "typing…" state. window.desktop.onServerCrash is the IPC
// channel from desktop/src/preload.ts; undefined in the browser version.
try {
  window.desktop?.onServerCrash?.((info) => {
    console.warn('[desktop] Server crashed:', info);
    window.desktop?.showNotification?.('Local Agent X', 'Server crashed — restarting automatically');
    document.dispatchEvent(new CustomEvent('lax:server-crashed', { detail: info }));
  });
} catch { /* preload bridge unavailable, browser context */ }

// Desktop-only: boot found desktop/dist stale with no rebuild scheduled
// (failed update pre-build / degraded deps) — surface it in-app via the
// standard health banner instead of a log line nobody reads. Channel:
// desktop/src/reconcile.ts surfaceStaleDesktopDist → preload onDesktopBuildStale.
try {
  window.desktop?.onDesktopBuildStale?.((info) => {
    console.warn('[desktop] Desktop build stale:', info);
    const msg = 'Desktop app build is out of date — ' + (info && info.reason ? info.reason : 'reason unknown');
    if (typeof window.showHealthBanner === 'function') window.showHealthBanner(msg);
  });
} catch { /* preload bridge unavailable, browser context */ }
