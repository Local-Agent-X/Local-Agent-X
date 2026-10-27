// Offline apps: what the phone downloads from the desktop (GET /api/apps/<id>/bundle),
// the app state both hold, and the component-values merge both run. The phone applies
// a user's change to its local copy while the desktop is unreachable and replays it to
// POST /api/apps/<id>/state on reconnect, tagged with the same actionId, so the merge
// here is what makes a replay land exactly once: the desktop skips an actionId it has
// already applied, and the phone's local state is byte-for-byte what the desktop will
// hold after the replay.

import { asNumber, asRecord, asString, type Rec } from "./guards.js";

/** What an app the agent built may ask the device for, on every surface it runs on:
 *  the desktop serves it with a Permissions-Policy built from this list, and the
 *  phone's live viewer and its downloaded copy allow the same. Each request still
 *  asks the user. One list, so an app that works on one surface works on the others
 *  (a downloaded camera app had none of what the live one allowed, 2026-10-26). */
export const APP_DEVICE_CAPABILITIES = ["camera", "microphone", "geolocation"] as const;
export type AppDeviceCapability = (typeof APP_DEVICE_CAPABILITIES)[number];

/** The Permissions-Policy header value for an app's page: each capability for the
 *  app's own origin only, so a third-party frame inside it gets none. */
export function appPermissionsPolicy(): string {
  return APP_DEVICE_CAPABILITIES.map((c) => `${c}=(self)`).join(", ");
}

/** Cap on the applied-actions ledger, so a long-lived app's state can't grow without limit. */
export const MAX_APPLIED_ACTIONS = 500;

export type AppStateMetadata = {
  lastAgentUpdate: number;
  lastUserUpdate: number;
  version: number;
};

/** An app's state as it crosses between the devices. `appliedActions` is absent on
 *  state the desktop saved before the ledger existed; the merge treats that as empty. */
export type AppStateSnapshot = {
  componentValues: Record<string, unknown>;
  appliedActions?: string[];
  metadata: AppStateMetadata;
};

/** One static file the phone persists to run the app offline. */
export type BundleFile = {
  /** App-relative path, forward-slashed (e.g. "index.html", "css/app.css"). */
  path: string;
  /** File contents: base64 when `encoding` is "base64", else UTF-8 text. */
  content: string;
  encoding: "utf-8" | "base64";
};

/** The complete offline payload for one app. */
export type AppBundlePayload = {
  appId: string;
  version: string;
  /** Entry document the WebView loads offline; one of `files`. */
  entry: string;
  files: BundleFile[];
  /** Live state snapshot at download time, or null when the app has no state. */
  state: AppStateSnapshot | null;
};

/** The body of POST /api/apps/<id>/state. `actionId` is the phone's idempotency key
 *  for a replayed offline action; a body without one is a plain merge. */
export type StateUpdateBody = {
  values: Record<string, unknown>;
  actionId?: string;
};

export function buildStateUpdate(values: Record<string, unknown>, actionId?: string): StateUpdateBody {
  return actionId === undefined ? { values } : { values, actionId };
}

/** A body that carries no `values` wrapper is the merge payload itself, unless it names
 *  an actionId (then the id must not be merged in as a component value). */
export function parseStateUpdate(raw: unknown): StateUpdateBody | null {
  const r = asRecord(raw);
  if (!r) return null;
  const actionId = asString(r.actionId);
  const wrapped = asRecord(r.values);
  const values = wrapped ?? (actionId === null ? r : {});
  return actionId === null ? { values } : { values, actionId };
}

export type MergeResult<S> = { state: S; duplicate: boolean };

/**
 * Merge `values` into the state's component values: a new state with the values
 * spread over the old ones, the version bumped, and the actor's timestamp set. With an
 * actionId already in the ledger the state comes back unchanged and `duplicate` is
 * true; otherwise the id joins the ledger, which keeps its newest MAX_APPLIED_ACTIONS.
 */
export function mergeComponentValues<S extends AppStateSnapshot>(
  state: S,
  values: Record<string, unknown>,
  by: "agent" | "user",
  at: number,
  actionId?: string,
): MergeResult<S> {
  let appliedActions = state.appliedActions;
  if (actionId !== undefined) {
    const applied = state.appliedActions ?? [];
    if (applied.includes(actionId)) return { state, duplicate: true };
    const grown = [...applied, actionId];
    appliedActions = grown.length > MAX_APPLIED_ACTIONS ? grown.slice(-MAX_APPLIED_ACTIONS) : grown;
  }
  const metadata: AppStateMetadata = {
    ...state.metadata,
    version: state.metadata.version + 1,
    ...(by === "agent" ? { lastAgentUpdate: at } : { lastUserUpdate: at }),
  };
  const next: S = { ...state, componentValues: { ...state.componentValues, ...values }, metadata };
  if (appliedActions !== undefined) next.appliedActions = appliedActions;
  return { state: next, duplicate: false };
}

// ── parsers (the phone reads these off the wire; a malformed row is dropped) ──

/** A snapshot off the wire, with the ledger always present and numbers defaulted to 0. */
export function parseAppStateSnapshot(raw: unknown): (AppStateSnapshot & { appliedActions: string[] }) | null {
  const r = asRecord(raw);
  if (!r) return null;
  const md = asRecord(r.metadata) ?? {};
  const num = (v: unknown): number => asNumber(v) ?? 0;
  return {
    componentValues: asRecord(r.componentValues) ?? {},
    appliedActions: Array.isArray(r.appliedActions) ? r.appliedActions.filter((x): x is string => typeof x === "string") : [],
    metadata: { lastAgentUpdate: num(md.lastAgentUpdate), lastUserUpdate: num(md.lastUserUpdate), version: num(md.version) },
  };
}

export function parseBundleFile(raw: unknown): BundleFile | null {
  const r = asRecord(raw);
  if (!r) return null;
  const path = asString(r.path);
  const content = asString(r.content);
  if (path === null || path.length === 0 || content === null) return null;
  if (r.encoding !== "utf-8" && r.encoding !== "base64") return null;
  return { path, content, encoding: r.encoding };
}

/** A bundle off the wire: malformed files are dropped, but the entry must be among
 *  those kept, or there is nothing to load. */
export function parseAppBundle(raw: unknown): (AppBundlePayload & { state: ReturnType<typeof parseAppStateSnapshot> }) | null {
  const r: Rec | null = asRecord(raw);
  if (!r) return null;
  const appId = asString(r.appId);
  const version = asString(r.version);
  const entry = asString(r.entry);
  if (appId === null || appId.length === 0 || version === null || entry === null || !Array.isArray(r.files)) return null;
  const files = r.files.map(parseBundleFile).filter((f): f is BundleFile => f !== null);
  if (!files.some((f) => f.path === entry)) return null;
  return { appId, version, entry, files, state: parseAppStateSnapshot(r.state) };
}
