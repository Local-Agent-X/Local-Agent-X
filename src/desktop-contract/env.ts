// The environment variables the desktop app and the server child exchange.
// The desktop sets most of them when it spawns the server (desktop/src/
// server-process.ts); the server reads them by these names and nowhere else,
// so a renamed variable fails to compile on both sides instead of silently
// reading undefined.
export const DESKTOP_ENV = {
  /** Electron main's pid: the server's heartbeat exits when it dies. */
  PARENT_PID: "LAX_PARENT_PID",
  /** "1" when the server was spawned with an IPC channel to Electron main. */
  BRIDGE: "LAX_DESKTOP_BRIDGE",
  ELECTRON_VERSION: "LAX_DESKTOP_ELECTRON_VERSION",
  CHROMIUM_VERSION: "LAX_DESKTOP_CHROMIUM_VERSION",
  /** The OS Documents folder, as Electron resolves it (may be OneDrive-redirected). */
  DOCUMENTS_DIR: "LAX_DOCUMENTS_DIR",
  /** The packaged app's resources dir, holding the bundled Whisper models. */
  BUNDLED_MODELS_DIR: "LAX_BUNDLED_MODELS_DIR",
  /** The packaged app's resources dir, holding the bundled binaries (ripgrep). */
  BUNDLED_BIN_DIR: "LAX_BUNDLED_BIN_DIR",
  /** The in-app browser's loopback DevTools port, when native driving is on. */
  ELECTRON_CDP_PORT: "LAX_ELECTRON_CDP_PORT",
  /** Relocates the data directory (data-dir.ts); honoured by both sides. */
  DATA_DIR: "LAX_DATA_DIR",
} as const;

export type DesktopEnvName = (typeof DESKTOP_ENV)[keyof typeof DESKTOP_ENV];
