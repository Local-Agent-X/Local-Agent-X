// Conversations: how the desktop lists them to the phone (GET /api/sessions over the
// tunnel) and what a session id may look like. The desktop's list rows carry more than
// this; these are the fields the phone shows, so a rename on the desktop fails its
// compile against this type instead of emptying the phone's drawer.

import { asNumber, asRecord, asString } from "./guards.js";

/** One conversation in the list. `projectId` is set when it is filed under a project. */
export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  projectId?: string;
};

/** Session ids are path and file-name safe on both devices: alphanumeric, dash and
 *  underscore, at most 64 characters. A client mints ids within this. */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/** Narrow the list body to summaries; a row without a usable id is dropped, and a row
 *  without a title reads as a new chat. */
export function parseSessionSummaries(raw: unknown): SessionSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionSummary[] = [];
  for (const row of raw) {
    const r = asRecord(row);
    const id = r ? asString(r.id) : null;
    if (!r || id === null || !isValidSessionId(id)) continue;
    const title = asString(r.title);
    const projectId = asString(r.projectId);
    out.push({
      id,
      title: title !== null && title.trim() !== "" ? title : "New chat",
      updatedAt: asNumber(r.updatedAt) ?? 0,
      messageCount: asNumber(r.messageCount) ?? 0,
      ...(projectId !== null && projectId !== "" ? { projectId } : {}),
    });
  }
  return out;
}
