/**
 * Which apps the user has allowed to talk to their agents.
 *
 * An app the agent built can start chat turns (routes/app-chat.ts), and those
 * turns run with the user's own powers. That is the user's call, per app,
 * made once on a card in the inbox (inbox/app-chat-approval.ts) and kept here
 * until they take it back on the Apps page. No app is allowed by default, and
 * nothing the agent can reach writes this file: the grants route answers the
 * operator alone (routes/app-chat.ts), the inbox refuses the agent, and the
 * file is one the agent's file tools may not touch (lax-data-catalog.ts).
 *
 * "denied" is remembered too, so an app the user said no to does not ask again
 * on every call. Forgetting an app (the Apps page's control) clears either
 * answer; the app's next call asks afresh.
 */

import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";

export type AppChatAnswer = "granted" | "denied";

export interface AppChatGrant {
  appId: string;
  answer: AppChatAnswer;
  /** Epoch ms of the user's answer. */
  at: number;
}

interface GrantFile extends Record<string, unknown> {
  grants: Record<string, { answer: AppChatAnswer; at: number }>;
}

const store = createJsonStore<GrantFile>(() => join(getLaxDir(), "app-chat-grants.json"), {
  defaults: () => ({ grants: {} }),
});

function valid(entry: unknown): entry is { answer: AppChatAnswer; at: number } {
  const e = entry as { answer?: unknown; at?: unknown } | null;
  return !!e && (e.answer === "granted" || e.answer === "denied") && typeof e.at === "number";
}

/** The user's answer for this app, or undefined when they have not been asked
 *  (or took their answer back). */
export function appChatAnswer(appId: string): AppChatAnswer | undefined {
  const entry = store.load().grants[appId];
  return valid(entry) ? entry.answer : undefined;
}

export function recordAppChatAnswer(appId: string, answer: AppChatAnswer, now: number = Date.now()): void {
  store.mutate((draft) => { draft.grants[appId] = { answer, at: now }; });
}

/** Take the answer back. True when there was one. */
export function forgetAppChatAnswer(appId: string): boolean {
  return store.mutate((draft) => {
    if (!(appId in draft.grants)) return false;
    delete draft.grants[appId];
    return true;
  });
}

export function listAppChatGrants(): AppChatGrant[] {
  return Object.entries(store.load().grants)
    .filter(([, entry]) => valid(entry))
    .map(([appId, entry]) => ({ appId, answer: entry.answer, at: entry.at }))
    .sort((a, b) => a.appId.localeCompare(b.appId));
}
