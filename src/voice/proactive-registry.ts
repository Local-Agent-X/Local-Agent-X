/**
 * Registry of active voice sessions that can be spoken to proactively.
 *
 * A voice session registers its turn machine's `speakProactive` under its
 * sessionId on creation and clears it on close. The server (a background op
 * finishing, or a worker needing input) calls `speakToActiveVoice(sessionId,
 * text)` to have the agent voice a line at the next turn boundary — see
 * turn-runner `speakProactive` for the never-cut-off queueing.
 *
 * Reached from the ops layer through the session-bridge DI seam
 * (setVoiceProactiveSpeaker) so ops never imports the voice layer directly.
 */
import { createLogger } from "../logger.js";
const logger = createLogger("voice.proactive-registry");

const speakers = new Map<string, (text: string) => void>();

export function registerVoiceSpeaker(sessionId: string, speak: (text: string) => void): void {
  if (!sessionId) return;
  speakers.set(sessionId, speak);
}

export function unregisterVoiceSpeaker(sessionId: string): void {
  if (sessionId) speakers.delete(sessionId);
}

/** True when there is a live voice session for this id (used to decide whether
 *  to speak vs fall back to the chat-only nudge). */
export function hasActiveVoice(sessionId: string): boolean {
  return !!sessionId && speakers.has(sessionId);
}

/** Hand a line to the active voice session for this id. Returns true if a
 *  session took it; false when none is connected (caller keeps the chat path). */
export function speakToActiveVoice(sessionId: string, text: string): boolean {
  const speak = sessionId ? speakers.get(sessionId) : undefined;
  if (!speak) return false;
  try {
    speak(text);
    return true;
  } catch (e) {
    logger.warn(`[proactive] speak threw for ${sessionId}: ${(e as Error).message}`);
    return false;
  }
}
