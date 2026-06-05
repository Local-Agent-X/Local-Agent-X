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
