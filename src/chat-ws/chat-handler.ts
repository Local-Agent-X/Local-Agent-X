// Chat handler registry — the single seam where the server plugs its
// turn-runner into chat-ws. wireWsChat (src/server/lifecycle.ts) registers the
// handler via manager.onChat; message-router invokes it per validated `chat`
// frame. Lives outside state.ts so the buffer/replay state stays one concern.

import type { ChannelId } from "../channel-context.js";
import type { ChatMode } from "../session/mode.js";

/** Per-message metadata the router derives from the frame (beyond the payload). */
export interface ChatFrameMeta {
  /** Frame-claimed origin, validated by parseFrameOrigin — today only the
   *  broker bridge's "mobile" stamp. Absent = the default surface ("web"). */
  channel?: ChannelId;
  /** The frame's project: a string files the session under it, null takes it out.
   *  Absent when the frame carried none (the phone, the App IDE): the session keeps
   *  the project it has. */
  projectId?: string | null;
  /** The mode a new session is created in; ignored once it has messages. */
  mode?: ChatMode;
}

export type ChatHandler = (sessionId: string, message: string, attachments: unknown[], meta?: ChatFrameMeta) => void;

// Set by the server to process WS chat messages.
let chatHandler: ChatHandler | null = null;
export function setChatHandler(h: ChatHandler): void { chatHandler = h; }
export function getChatHandler(): ChatHandler | null { return chatHandler; }
