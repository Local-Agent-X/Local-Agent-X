/**
 * Preload — exposes a safe bridge from the renderer (web UI) to the
 * Electron main process. The web UI can call these via window.desktop.
 */

import { contextBridge, ipcRenderer } from "electron";

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
  quit: () => ipcRenderer.invoke("quit-app"),

  // Open the tokenized LAX URL in the user's default browser (escape hatch
  // for Web Speech API, sharing with another tool on the same box, etc.)
  // and copy that same URL to clipboard. Both read live from config so
  // they survive a server port rotation.
  openInBrowser: () => ipcRenderer.invoke("open-in-browser"),
  copyAppUrl: () => ipcRenderer.invoke("copy-app-url"),

  // File operations
  openFile: (relativePath: string) => ipcRenderer.invoke("open-file", relativePath),

  // App-window chrome tinting. App pages call this with their detected
  // body background color and a contrasting symbol color; main repaints
  // the native titleBarOverlay so the OS button strip blends with the
  // app's content instead of clashing with LAX's theme.
  reportChromeTint: (color: string, symbolColor: string) =>
    ipcRenderer.invoke("report-chrome-tint", color, symbolColor),

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
