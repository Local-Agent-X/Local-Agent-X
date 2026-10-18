// GENERATED from src/desktop-contract/browser-bridge.ts by scripts/check-desktop-contract.mjs --sync. Do not edit.
// The browser-view message family on the server↔Electron-main IPC channel:
// the server drives the in-app WebContentsView pool through these, and the
// desktop pushes page activity, downloads and per-hop egress asks back. Same
// transport and reply idiom as ipc.ts ("<type>-result" echoing the request
// id). Both sides type their senders and handlers from here.

export interface BridgeRect { x: number; y: number; width: number; height: number }

/** Every browser view lives on a partition in this namespace: the desktop
 *  refuses any other (browser-partition.ts), since the bare default session
 *  carries the app's own token. The server names a scheduled job's profile
 *  with it (browser/session-owner-registry.ts jobBrowserPartition). */
export const BROWSER_PARTITION_PREFIX = "persist:lax-profile-";

export interface BrowserViewInfo {
  viewId: string;
  partition: string;
  url: string;
  title: string;
  attached: boolean;
  agentDriven: boolean;
}

/** "adopt"/"release": the server's mirror of user-view adoption (the agent
 *  took over / let go of a user tab via switch_tab), so the desktop's trust
 *  resolver treats the view as agent-driven while adopted (downloads →
 *  quarantine, no user-loopback carve-out) — matching the server egress
 *  gate's attribution of adopted-tab requests to the driving session. */
export type BrowserLifecycleOp = "create" | "show" | "hide" | "close" | "setBounds" | "ping" | "list" | "adopt" | "release";

export type BridgeInputModifier = "shift" | "control" | "alt" | "meta";
export interface BridgeMouseEvent {
  type: "mouseDown" | "mouseUp" | "mouseMove";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  modifiers?: BridgeInputModifier[];
}
export interface BridgeMouseWheelEvent {
  type: "mouseWheel";
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: BridgeInputModifier[];
}
export interface BridgeKeyEvent {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers?: BridgeInputModifier[];
}
export type BridgeInputEvent = BridgeMouseEvent | BridgeMouseWheelEvent | BridgeKeyEvent;

// ── Server → main ─────────

export interface BrowserLifecycleRequest {
  type: "lax:browser-lifecycle";
  id: number;
  op: BrowserLifecycleOp;
  viewId: string;
  bounds?: BridgeRect;
  /** The agent session driving the surface (op "show") — attributes the anchor
   *  follow so the desktop records a per-session anchor (never a cross-session steal). */
  sessionId?: string;
  /** The partition the view lives on (op "create"); the shared signed-in
   *  profile when absent. A scheduled job's views name the job's own. */
  partition?: string;
}
export interface BrowserNavigateRequest { type: "lax:browser-navigate"; id: number; viewId: string; url: string; timeoutMs?: number; sessionId?: string }
export interface BrowserExecRequest { type: "lax:browser-exec"; id: number; viewId: string; script: string; world?: "isolated"; allFrames?: boolean }
export interface BrowserInputRequest { type: "lax:browser-input"; id: number; viewId: string; event: BridgeInputEvent }
export interface BrowserCaptureRequest { type: "lax:browser-capture"; id: number; viewId: string }
export interface BrowserClearPartitionRequest { type: "lax:browser-clear-partition"; id: number; partition: string }
/** Stop the view's in-flight load; no id, no reply. */
export interface BrowserAbortRequest { type: "lax:browser-abort"; viewId: string }
export interface BrowserReadConsoleRequest { type: "lax:browser-read-console"; id: number; viewId: string }
export interface BrowserReadNetworkRequest { type: "lax:browser-read-network"; id: number; viewId: string }
/** Beforeunload dialog queue: list pending, or accept/dismiss the next entry. */
export interface BrowserDialogsRequest { type: "lax:browser-dialogs"; id: number; viewId: string; op: "list" | "accept" | "dismiss" }
/** The server's answer to a per-hop egress ask (below). */
export interface BrowserEgressAskResult { type: "lax:browser-egress-ask-result"; id: number; allowed: boolean }
/** Announce (no id, no reply): the off-loop egress worker's pipe endpoint,
 *  re-sent on every worker (re)boot with a fresh nonce name. */
export interface BrowserEgressEndpointAnnounce { type: "lax:browser-egress-endpoint"; pipeName: string }

export type BrowserBridgeMessage =
  | BrowserLifecycleRequest | BrowserNavigateRequest | BrowserExecRequest | BrowserInputRequest
  | BrowserCaptureRequest | BrowserClearPartitionRequest | BrowserAbortRequest
  | BrowserReadConsoleRequest | BrowserReadNetworkRequest | BrowserDialogsRequest
  | BrowserEgressAskResult | BrowserEgressEndpointAnnounce;

export const BROWSER_MESSAGE_TYPES = [
  "lax:browser-lifecycle", "lax:browser-navigate", "lax:browser-exec", "lax:browser-input",
  "lax:browser-capture", "lax:browser-clear-partition", "lax:browser-abort",
  "lax:browser-read-console", "lax:browser-read-network", "lax:browser-dialogs",
  "lax:browser-egress-ask-result", "lax:browser-egress-endpoint",
] as const satisfies readonly BrowserBridgeMessage["type"][];

export function isBrowserBridgeMessage(msg: { type?: unknown }): msg is BrowserBridgeMessage {
  return typeof msg?.type === "string" && (BROWSER_MESSAGE_TYPES as readonly string[]).includes(msg.type);
}

// ── Main → server ─────────

export interface BridgeConsoleEntry { level: string; message: string; ts: number }
export interface BridgeNetworkEntry {
  url: string;
  method: string;
  status?: number;
  error?: string;
  resourceType?: string;
  contentType?: string;
  ts: number;
}
export interface InAppDialogSummary { type: string; message: string }

/** Ping payload: liveness + url/title + the view's real layout bounds. */
export interface BridgePingResult {
  ok: boolean;
  url?: string;
  title?: string;
  userActive?: boolean;
  bounds?: { width: number; height: number };
}

/** Every "<type>-result" reply: `ok` plus the fields the op produced. */
export interface BridgeReply {
  type: string;
  id: number;
  ok: boolean;
  error?: string;
  view?: BrowserViewInfo;
  views?: BrowserViewInfo[];
  ping?: BridgePingResult;
  url?: string;
  title?: string;
  result?: unknown;
  pngB64?: string;
  allowed?: boolean;
  /** The co-drive refusal (input op only): the human is driving the view. */
  userActive?: boolean;
  status?: number;
  entries?: BridgeConsoleEntry[];
  network?: { entries: BridgeNetworkEntry[]; inFlight: number };
  dialogs?: InAppDialogSummary[];
  handled?: InAppDialogSummary | null;
}

export const BROWSER_RESULT_TYPES = [
  "lax:browser-lifecycle-result", "lax:browser-navigate-result", "lax:browser-exec-result",
  "lax:browser-input-result", "lax:browser-capture-result", "lax:browser-clear-partition-result",
  "lax:browser-read-console-result", "lax:browser-read-network-result", "lax:browser-dialogs-result",
] as const;

/** Per-hop egress ask: the desktop partition fails closed and asks the server
 *  to decide each in-app browser request. Same shape over the worker pipe
 *  (without `type`) and over IPC. */
export interface BrowserEgressAsk {
  type: "lax:browser-egress-ask";
  id: number;
  url: string;
  method?: string;
  pageUrl?: string;
  body?: string;
  viewId?: string;
}
/** User-view activity (navigation, title, open, close); fire-and-forget. */
export interface BrowserUiEvent { type: "lax:browser-ui-event"; surface: "browser"; action: string; viewId: string; ts: number; target?: string }
/** The user closed an agent view from the tab strip; fire-and-forget. */
export interface BrowserAgentViewClosed { type: "lax:browser-agent-view-closed"; viewId: string; ts: number }
/** A quarantined download reached a terminal state; fire-and-forget. `viewId`
 *  is null for a download no pool view triggered (a popup); the server keeps
 *  only agent-attributed ones. */
export interface BrowserDownloadEvent {
  type: "lax:browser-download-event";
  viewId: string | null;
  download: { id: string; url: string; pageUrl: string; filename: string; mime: string; bytes: number; state: string; savePath: string };
}

export const BROWSER_PUSH_TYPES = [
  "lax:browser-egress-ask", "lax:browser-ui-event", "lax:browser-agent-view-closed", "lax:browser-download-event",
] as const;
