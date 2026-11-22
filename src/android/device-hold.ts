/**
 * One chat drives an Android device at a time.
 *
 * A phone or an emulator is one screen: it cannot be per chat the way a
 * browser view or a shell can. Two chats' agents tapping the same device
 * each undo what the other did, and neither can tell why its screenshots
 * stopped matching its taps. So the chat whose agent last drove a device
 * holds it, and another chat's agent is told who has it instead of driving
 * it too.
 *
 * A hold is not a lock to take and release: it follows use, and lapses after
 * HOLD_IDLE_MS without a driving call, so a chat that finished (or whose
 * agent died) never keeps a device from the others. Looking at the device
 * (a screenshot, a listing) is never held back, and neither is the person:
 * the ANDROID tab's own buttons are not an agent's calls.
 *
 * The holder is the chat a run belongs to, not the run's own session: a
 * build's worker drives the device for the chat that started the build.
 */

/** A device is free again this long after its holder last drove it. */
export const HOLD_IDLE_MS = 5 * 60_000;

interface Hold { chat: string; at: number }

const holds = new Map<string, Hold>();

function liveHold(serial: string, now: number): Hold | undefined {
  const hold = holds.get(serial);
  if (hold && now - hold.at >= HOLD_IDLE_MS) {
    holds.delete(serial);
    return undefined;
  }
  return hold;
}

/**
 * `chat` is about to drive `serial`. Returns null when it holds the device
 * (now, or already), or the chat that holds it instead.
 */
export function holdDevice(serial: string, chat: string, now: number = Date.now()): string | null {
  const hold = liveHold(serial, now);
  if (hold && hold.chat !== chat) return hold.chat;
  holds.set(serial, { chat, at: now });
  return null;
}

/** The chat holding `serial`, if any. */
export function deviceHolder(serial: string, now: number = Date.now()): string | undefined {
  return liveHold(serial, now)?.chat;
}

/** A device went away (its emulator was stopped): nobody holds it. */
export function releaseDevice(serial: string): void {
  holds.delete(serial);
}

/** Test seam. */
export function _resetDeviceHoldsForTest(): void {
  holds.clear();
}
