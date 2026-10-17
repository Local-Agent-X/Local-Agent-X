// GENERATED from src/desktop-contract/ipc.ts by scripts/check-desktop-contract.mjs --sync. Do not edit.
// The native-capability messages on the server↔Electron-main IPC channel
// (process.send over the 'ipc' stdio fd). Requests carry an `id` the reply
// echoes; the one-way pushes carry none. The browser-view family is in
// browser-bridge.ts. Both sides type their senders and handlers from here,
// so a renamed message or a renamed field fails to compile on both.

// ── Server → main ─────────

/** Move a path to the OS Trash / Recycle Bin with Put Back / Restore. */
export interface TrashItemRequest { type: "lax:trash-item"; id: number; path: string }
/** Load a built app in a hidden window and report runtime evidence. */
export interface ProbeAppRequest { type: "lax:probe-app"; id: number; url: string; timeoutMs?: number; wantScreenshot?: boolean }
/** Capture the screen in main, which holds the macOS Screen Recording grant. */
export interface CaptureScreenRequest {
  type: "lax:capture-screen"; id: number;
  monitor?: number; region?: { x: number; y: number; width: number; height: number };
  format?: "png" | "jpg"; quality?: number; scale?: number;
}
/** Restart the server child (picks up new src/dist); no reply. */
export interface RestartServerRequest { type: "lax:restart-server" }
/** Relaunch the whole app (picks up desktop/ changes too); no reply. */
export interface RelaunchAppRequest { type: "lax:relaunch-app" }
/** One Android device frame for the renderer's canvas; no reply. */
export interface AndroidFrameMessage { type: "lax:android-frame"; viewId: string; pngBase64: string }

export type ServerToMainMessage =
  | TrashItemRequest | ProbeAppRequest | CaptureScreenRequest
  | RestartServerRequest | RelaunchAppRequest | AndroidFrameMessage;

export const SERVER_TO_MAIN_TYPES = [
  "lax:trash-item", "lax:probe-app", "lax:capture-screen", "lax:restart-server", "lax:relaunch-app", "lax:android-frame",
] as const satisfies readonly ServerToMainMessage["type"][];

// ── Main → server ─────────

export interface TrashItemReply { type: "lax:trash-item-result"; id: number; ok: boolean }

/** One runtime finding from the probe window. `kind` maps onto the
 *  render-verify PreviewRuntimeError kinds: console | resource | error | blank. */
export interface ProbeAppError { kind: string; message: string; source?: string; line?: number }
export interface ProbeAppReply {
  type: "lax:probe-app-result"; id: number; ok: boolean;
  /** did-finish-load fired before the deadline. */
  booted: boolean;
  errors: ProbeAppError[];
  /** PNG; present only when requested and under main's size cap. */
  screenshotB64?: string;
  error?: string;
}

export interface CaptureScreenReply {
  type: "lax:capture-screen-result"; id: number; ok: boolean;
  imageB64?: string; format?: "png" | "jpg"; width?: number; height?: number; error?: string;
}

/** The desktop PANIC hotkey: abort every run and disarm computer control; no reply. */
export interface PanicAbortMessage { type: "lax:panic-abort" }

export type MainToServerMessage = TrashItemReply | ProbeAppReply | CaptureScreenReply | PanicAbortMessage;

export const MAIN_TO_SERVER_TYPES = [
  "lax:trash-item-result", "lax:probe-app-result", "lax:capture-screen-result", "lax:panic-abort",
] as const satisfies readonly MainToServerMessage["type"][];

export function isServerToMainMessage(msg: unknown): msg is ServerToMainMessage {
  return hasType(msg) && (SERVER_TO_MAIN_TYPES as readonly string[]).includes(msg.type);
}

export function isMainToServerMessage(msg: unknown): msg is MainToServerMessage {
  return hasType(msg) && (MAIN_TO_SERVER_TYPES as readonly string[]).includes(msg.type);
}

function hasType(msg: unknown): msg is { type: string } {
  return !!msg && typeof msg === "object" && typeof (msg as { type?: unknown }).type === "string";
}
