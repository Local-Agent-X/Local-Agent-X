// The phone's inbox frames on the chat socket (agentxos inbox.ts, vendored in
// src/broker-transport/vendor/): `inbox_list` is answered with the whole visible
// inbox, `inbox_read` and `inbox_act` are the user's answers. The live frames the
// phone reads between snapshots (`inbox_item`, `inbox_changed`) are the bell's
// own, broadcast by src/inbox/ and src/routes/inbox.ts to every chat client.
//
// An answer runs through the same two functions the HTTP route runs
// (routes/inbox.ts `mutateInbox` / `actOnInbox`), registered by the server with
// its context the way the chat handler is (chat-handler.ts): Approve dispatches
// the stored call through every gate exactly as a click in the bell does; there
// is no second approval path. A refusal is a top-level `error` frame, which the
// phone reads as the answer to its control (parseControlError).

import type { WebSocket } from "ws";
import type { InboxSnapshotFrame } from "../broker-transport/vendor/protocol.js";
import { listInbox } from "../inbox/index.js";
import { INBOX_REFUSAL_TEXT, type InboxActResult } from "../inbox/approvals.js";
import { sendFrame } from "./frames.js";

export type InboxMutation = "read" | "read_all" | "dismiss" | "resolve";

export interface InboxAnswerer {
  /** The bell's plain answers, applied and broadcast; false when no item has that id. */
  mutate(action: InboxMutation, id: string): boolean;
  /** Approve or decline a parked call, run and broadcast as the bell's answer is. */
  act(id: string, action: "approve" | "decline"): Promise<InboxActResult>;
}

let answerer: InboxAnswerer | null = null;

export function setInboxAnswerer(next: InboxAnswerer | null): void {
  answerer = next;
}

/** The answer to `inbox_list`, typed against the phone's contract. */
export function buildInboxSnapshot(): InboxSnapshotFrame {
  return { type: "inbox_snapshot", ...listInbox() };
}

const ACT_ACTIONS: readonly string[] = ["approve", "decline", "dismiss", "resolve"];

/** True when the frame was an inbox frame (answered or refused on `ws`). */
export async function handleInboxFrame(ws: WebSocket, msg: Record<string, unknown>): Promise<boolean> {
  const type = msg.type;
  if (type === "inbox_list") {
    if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(buildInboxSnapshot()));
    return true;
  }
  if (type !== "inbox_read" && type !== "inbox_act") return false;
  const refuse = (message: string) => sendFrame(ws, { type: "error", message });
  if (!answerer) { refuse("The inbox cannot be answered yet: the server is still starting."); return true; }
  const id = typeof msg.id === "string" ? msg.id : "";
  if (type === "inbox_read") {
    if (!answerer.mutate(id ? "read" : "read_all", id)) refuse(`${INBOX_REFUSAL_TEXT.missing} (${id})`);
    return true;
  }
  const action = msg.action;
  if (!id || typeof action !== "string" || !ACT_ACTIONS.includes(action)) {
    refuse("inbox_act needs an id and an action: approve, decline, dismiss or resolve");
    return true;
  }
  if (action === "dismiss" || action === "resolve") {
    if (!answerer.mutate(action, id)) refuse(`${INBOX_REFUSAL_TEXT.missing} (${id})`);
    return true;
  }
  const result = await answerer.act(id, action as "approve" | "decline");
  if (!result.ok) refuse(INBOX_REFUSAL_TEXT[result.refused]);
  return true;
}
