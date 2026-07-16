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
    navigate: (url: string) => ipcRenderer.invoke("browser-navigate", url),
    goBack: () => ipcRenderer.invoke("browser-go-back"),
    goForward: () => ipcRenderer.invoke("browser-go-forward"),
    reload: () => ipcRenderer.invoke("browser-reload"),
    getNavState: (): Promise<{
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
    }> => ipcRenderer.invoke("browser-get-nav-state"),
    onNavState: (cb: (state: {
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
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
    } | null> => ipcRenderer.invoke("browser-switch-view", viewId),
    // Profile manager "Log in once": open (or reuse) a FOREGROUND view on the
    // given profile's partition and navigate it, so the user can sign in by hand
    // — the partition persists the login. url omitted → about:blank.
    openProfileView: (profileId: string, url?: string): Promise<{
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
    } | null> => ipcRenderer.invoke("browser-open-profile-view", profileId, url),
    // New user tab: mint a fresh renderer-owned view on the currently selected
    // view's partition and drive it from the anchor. url omitted → about:blank.
    // Returns the new view's nav-state.
    newTab: (url?: string): Promise<{
      viewId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean;
    } | null> => ipcRenderer.invoke("browser-new-tab", url),
    // Pool-change poke: main sends "browser-views-changed" (no payload) when
    // views are created/closed or the attached view flips — re-list on it.
    onViewsChanged: (cb: () => void) => {
      ipcRenderer.on("browser-views-changed", () => cb());
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

  // Check if running inside desktop app
  isDesktop: true,
});
