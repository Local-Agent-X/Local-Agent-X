/**
 * Preload — exposes a safe bridge from the renderer (web UI) to the
 * Electron main process. The web UI can call these via window.desktop.
 */

import { contextBridge, ipcRenderer } from "electron";

// Platform body-class — set as early as possible so renderer CSS can
// condition window-chrome layout without waiting for IPC. macOS gets
// `platform-darwin` (native traffic-light spacing); Windows/Linux get
// `platform-win`, which shows the in-window titlebar shipped in app.html
// and reserves the 32px top strip for the OS min/max/close overlay.
// Previous attempt used main.webContents.insertCSS at did-finish-load,
// which silently no-op'd in some boot orderings (verified via DevTools:
// document.styleSheets had zero injected sheets). Setting the class from
// the preload's DOMContentLoaded listener is deterministic — the class
// is on <body> before any layout pass, so the bar can't disappear on a
// later client-side re-render the way the old injected version did.
{
  const platformClass = process.platform === "darwin" ? "platform-darwin" : "platform-win";
  // preload runs in a renderer context with DOM available, but the
  // desktop tsconfig doesn't include the DOM lib (it's mostly a
  // Node/Electron-main project). Cast through globalThis to access
  // document without dragging the whole DOM lib in.
  const doc = (globalThis as unknown as { document: {
    readyState: string;
    body: { classList: { add: (c: string) => void } };
    addEventListener: (ev: string, cb: () => void, opts?: { once?: boolean }) => void;
  } }).document;
  const apply = () => {
    try { doc.body.classList.add(platformClass); } catch {}
  };
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
}

contextBridge.exposeInMainWorld("desktop", {
  // Server
  getServerStatus: () => ipcRenderer.invoke("get-server-status"),
  restartServer: () => ipcRenderer.invoke("restart-server"),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke("set-setting", key, value),

  // Notifications
  showNotification: (title: string, body: string) =>
    ipcRenderer.invoke("show-notification", title, body),

  // macOS-only TCC prompt trigger. Renderer awaits this before getUserMedia
  // so the OS dialog actually appears the first time mic/camera is used —
  // without it, hardened-runtime Electron silently denies. Returns true on
  // non-macOS (TCC isn't a thing).
  requestMediaAccess: (mediaType: "microphone" | "camera"): Promise<boolean> =>
    ipcRenderer.invoke("request-media-access", mediaType),

  // System Permissions card (Settings → Security). openPrivacyPane deep-links to
  // the exact OS pane; checkPermission reports current grant status so the card
  // can show a live dot. macOS-only; checkPermission returns "unsupported" else.
  openPrivacyPane: (pane: "accessibility" | "screen" | "microphone"): Promise<boolean> =>
    ipcRenderer.invoke("open-privacy-pane", pane),
  checkPermission: (kind: "accessibility" | "screen" | "microphone"): Promise<string> =>
    ipcRenderer.invoke("check-permission", kind),

  // Native OS speech recognition — drop-in replacement for the broken
  // webkitSpeechRecognition path in Electron. The renderer treats this
  // like an event stream:
  //   nativeSpeech.available()              → boolean (helper binary present)
  //   nativeSpeech.start() / .stop()        → control the recognition session
  //   nativeSpeech.onEvent(cb)              → "result" + "error" + "auth" events
  nativeSpeech: {
    available: (): Promise<boolean> => ipcRenderer.invoke("native-speech-available"),
    start: (): Promise<void> => ipcRenderer.invoke("native-speech-start"),
    stop: (): Promise<void> => ipcRenderer.invoke("native-speech-stop"),
    onEvent: (cb: (event: unknown) => void) => {
      ipcRenderer.on("native-speech-event", (_e, ev) => cb(ev));
    },
  },

  // Window
  toggleWindow: () => ipcRenderer.invoke("toggle-window"),
  toggleDevTools: () => ipcRenderer.invoke("toggle-devtools"),
  // Content zoom for the in-window titlebar menu — routes to window.ts's
  // clamped, overlay-aware zoom (same path as Ctrl +/-/0) so the menu can't
  // compound with the keyboard zoom or push content under the chrome.
  contentZoom: (dir: "in" | "out" | "reset") => ipcRenderer.invoke("content-zoom", dir),
  quit: () => ipcRenderer.invoke("quit-app"),
  relaunchApp: () => ipcRenderer.invoke("relaunch-app"),

  // In-window titlebar (Windows/Linux). The bar is HTML so it can't use
  // Electron menu roles directly — these route Edit actions and About
  // through main, matching what the native macOS menu does via roles.
  editCommand: (role: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") =>
    ipcRenderer.invoke("titlebar-edit", role),
  showAbout: () => ipcRenderer.invoke("show-about"),

  // Open the tokenized LAX URL in the user's default browser (escape hatch
  // for Web Speech API, sharing with another tool on the same box, etc.)
  // and copy that same URL to clipboard. Both read live from config so
  // they survive a server port rotation.
  openInBrowser: () => ipcRenderer.invoke("open-in-browser"),
  copyAppUrl: () => ipcRenderer.invoke("copy-app-url"),

  // File operations
  openFile: (relativePath: string) => ipcRenderer.invoke("open-file", relativePath),

  // Reveal the ~/.lax/uploads folder in the OS file manager.
  openUploadsFolder: () => ipcRenderer.invoke("open-uploads-folder"),

  // Native folder picker (Settings → Server workspace). Resolves to the chosen
  // absolute path, or null if the user canceled.
  selectFolder: (opts?: { title?: string; defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke("select-folder", opts),

  // Native OK/Cancel confirm — for the restart-required prompt on a port /
  // workspace change. Resolves true when the user accepts.
  confirm: (opts: { message: string; detail?: string; okLabel?: string }): Promise<boolean> =>
    ipcRenderer.invoke("confirm", opts),

  // App-window chrome tinting. App pages call this with their detected
  // body background color and a contrasting symbol color; main repaints
  // the native titleBarOverlay so the OS button strip blends with the
  // app's content instead of clashing with LAX's theme.
  reportChromeTint: (color: string, symbolColor: string) =>
    ipcRenderer.invoke("report-chrome-tint", color, symbolColor),

  // In-app browser (right panel Browser tab). The page is a native
  // WebContentsView overlay drawn by main; the renderer reserves space,
  // reports the anchor rect (CSS px relative to the window content), and
  // toggles visibility. Nav-state pushes ("browser-nav-state") mirror the
  // real webContents back into the address bar.
  browser: {
    setBounds: (rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("browser-set-bounds", rect),
    setVisible: (visible: boolean) => ipcRenderer.invoke("browser-set-visible", visible),
    setChatOverlay: (payload: {
      bounds: { x: number; y: number; width: number; height: number };
      overlayUrl: string;
      sessionId: string | null;
      collapsed: boolean;
      latestOpen: boolean;
    } | null) => ipcRenderer.invoke("browser-set-chat-overlay", payload),
    onChatOverlayState: (cb: (state: {
      sessionId: string | null;
      collapsed: boolean;
      latestOpen: boolean;
    }) => void) => {
      ipcRenderer.on("browser-chat-overlay-state", (_e, state) => cb(state));
    },
    navigate: (url: string) => ipcRenderer.invoke("browser-navigate", url),
    goBack: () => ipcRenderer.invoke("browser-go-back"),
    goForward: () => ipcRenderer.invoke("browser-go-forward"),
    reload: () => ipcRenderer.invoke("browser-reload"),
    // Stop the current view's in-flight load (the toolbar's ↻ flips to ✕ while
    // the selected view is loading; browser-tab.js routes the click here).
    stop: () => ipcRenderer.invoke("browser-stop"),
    getNavState: (): Promise<{
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
      loadError: { code: number; description: string; url: string } | null;
    }> => ipcRenderer.invoke("browser-get-nav-state"),
    onNavState: (cb: (state: {
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
      loadError: { code: number; description: string; url: string } | null;
    }) => void) => {
      ipcRenderer.on("browser-nav-state", (_e, state) => cb(state));
    },
    // Multi-view switcher: enumerate every pool view (renderer foreground +
    // agent-driven per-(session,profile) views) and flip which one the anchor
    // drives/shows. switchView returns the switched-to view's nav-state.
    listViews: (): Promise<Array<{
      viewId: string; url: string; title: string; profileId?: string; attached: boolean; agentDriven: boolean;
    }>> => ipcRenderer.invoke("browser-list-views"),
    switchView: (viewId: string): Promise<{
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
      loadError: { code: number; description: string; url: string } | null;
    } | null> => ipcRenderer.invoke("browser-switch-view", viewId),
    // Close a user tab (foreground / user-N / profile-*). Agent 🤖 views are
    // refused main-side (they're the agent's) — resolves false for those and
    // for unknown ids; true when the view was closed.
    closeView: (viewId: string): Promise<boolean> => ipcRenderer.invoke("browser-close-view", viewId),
    // Profile manager "Log in once": open (or reuse) a FOREGROUND view on the
    // given profile's partition and navigate it, so the user can sign in by hand
    // — the partition persists the login. url omitted → about:blank.
    openProfileView: (profileId: string, url?: string): Promise<{
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
      loadError: { code: number; description: string; url: string } | null;
    } | null> => ipcRenderer.invoke("browser-open-profile-view", profileId, url),
    // New user tab: mint a fresh renderer-owned view on the currently selected
    // view's partition and drive it from the anchor. url omitted → about:blank.
    // Returns the new view's nav-state.
    newTab: (url?: string): Promise<{
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
      loadError: { code: number; description: string; url: string } | null;
    } | null> => ipcRenderer.invoke("browser-new-tab", url),
    // Downloads panel: user-routed downloads (openable) + read-only quarantined.
    listDownloads: (): Promise<{
      user: Array<{ id: string; filename: string; savePath: string; url: string; bytes: number; totalBytes: number; state: string; startedAt: number; doneAt?: number }>;
      quarantined: Array<{ id: string; filename: string; state: string; bytes: number; url: string }>;
    } | null> => ipcRenderer.invoke("browser-downloads-list"),
    openDownload: (id: string): Promise<boolean> => ipcRenderer.invoke("browser-download-open", id),
    revealDownload: (id: string): Promise<boolean> => ipcRenderer.invoke("browser-download-reveal", id),
    // Pool-change poke: main sends "browser-views-changed" (no payload) when
    // views are created/closed or the attached view flips — re-list on it.
    onViewsChanged: (cb: () => void) => {
      ipcRenderer.on("browser-views-changed", () => cb());
    },
    // Find-in-page on the SELECTED view. Results arrive via the tagged
    // "browser-found-in-page" push (same idiom as browser-nav-state — results
    // are async events, possibly several per request). next/prev re-send the
    // query; main continues the session with findNext:true.
    findStart: (query: string) => ipcRenderer.invoke("browser-find-start", query),
    findNext: (query: string) => ipcRenderer.invoke("browser-find-next", query),
    findPrev: (query: string) => ipcRenderer.invoke("browser-find-prev", query),
    findStop: () => ipcRenderer.invoke("browser-find-stop"),
    onFoundInPage: (cb: (r: {
      viewId: string; matches: number; activeMatchOrdinal: number; finalUpdate: boolean;
    }) => void) => {
      ipcRenderer.on("browser-found-in-page", (_e, r) => cb(r));
    },
    // Pushed when the user presses Ctrl+F / Esc while focus is INSIDE the
    // page itself (the view's own before-input-event, browser-page-controls.ts).
    onFindHotkey: (cb: (info: { viewId: string }) => void) => {
      ipcRenderer.on("browser-find-hotkey", (_e, info) => cb(info));
    },
    onFindClosed: (cb: (info: { viewId: string }) => void) => {
      ipcRenderer.on("browser-find-closed", (_e, info) => cb(info));
    },
    // Per-VIEW zoom — the page's own webContents, distinct from contentZoom
    // above (which zooms the main WINDOW). Every applied change is mirrored
    // back via "browser-zoom-changed" so the renderer's session map stays true.
    setZoom: (factor: number) => ipcRenderer.invoke("browser-set-zoom", factor),
    getZoom: (): Promise<{ viewId: string; factor: number } | null> =>
      ipcRenderer.invoke("browser-get-zoom"),
    onZoomChanged: (cb: (info: { viewId: string; factor: number }) => void) => {
      ipcRenderer.on("browser-zoom-changed", (_e, info) => cb(info));
    },
    // Agent auto-surface: main sends "browser-agent-surfaced" (with the viewId)
    // when an agent opens a website while the user isn't watching a real page —
    // the renderer opens the panel + switches to the Browser tab so the user
    // sees the agent browsing without hunting for the tab.
    onAgentSurfaced: (cb: (info: { viewId: string }) => void) => {
      ipcRenderer.on("browser-agent-surfaced", (_e, info) => cb(info));
    },
  },

  terminal: {
    create: (cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("terminal-create", cols, rows),
    write: (data: string): Promise<void> => ipcRenderer.invoke("terminal-write", data),
    resize: (cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("terminal-resize", cols, rows),
    dispose: (): Promise<void> => ipcRenderer.invoke("terminal-dispose"),
    onData: (cb: (data: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => cb(data);
      ipcRenderer.on("terminal-data", listener);
      return () => ipcRenderer.removeListener("terminal-data", listener);
    },
    onExit: (cb: (event: { exitCode: number; signal?: number }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, exit: { exitCode: number; signal?: number }) => cb(exit);
      ipcRenderer.on("terminal-exit", listener);
      return () => ipcRenderer.removeListener("terminal-exit", listener);
    },
  },

  // Server-crash signal: main fires "server-crashed" when the spawned
  // node server exits uncleanly (OOM / SIGKILL / nonzero code). The
  // renderer can subscribe to clear stuck "typing…" state and show a
  // banner while main auto-restarts. Without this, a mid-stream crash
  // leaves the chat UI silently frozen.
  onServerCrash: (cb: (info: { code: number | null; signal: string | null }) => void) => {
    ipcRenderer.on("server-crashed", (_e, info) => cb(info));
  },

  // Desktop-health signal: main fires "desktop-build-stale" when boot found
  // desktop/dist older than desktop/src with no rebuild scheduled (failed
  // update pre-build / degraded deps), or node_modules rewritten by a foreign
  // package manager (pnpm) — see desktop/src/reconcile-surface.ts. Same
  // pattern as onServerCrash; shared-desktop.js surfaces it via the health
  // banner, using the optional headline as the banner lead-in.
  onDesktopBuildStale: (cb: (info: { reason: string; headline?: string }) => void) => {
    ipcRenderer.on("desktop-build-stale", (_e, info) => cb(info));
  },

  // Check if running inside desktop app
  isDesktop: true,
});
