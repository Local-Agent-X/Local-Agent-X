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

// Desktop-only: boot found a desktop health problem — a stale desktop/dist
// with no rebuild scheduled (failed update pre-build / degraded deps), or a
// node_modules rewritten by a foreign package manager (pnpm). Surface it
// in-app via the standard health banner instead of a log line nobody reads.
// Channel: desktop/src/reconcile-surface.ts → preload onDesktopBuildStale.
// `headline` is optional (older mains send only `reason`).
try {
  window.desktop?.onDesktopBuildStale?.((info) => {
    console.warn('[desktop] Desktop health issue:', info);
    const headline = (info && info.headline) || 'Desktop app build is out of date';
    const msg = headline + ' — ' + (info && info.reason ? info.reason : 'reason unknown');
    if (typeof window.showHealthBanner === 'function') window.showHealthBanner(msg);
  });
} catch { /* preload bridge unavailable, browser context */ }
