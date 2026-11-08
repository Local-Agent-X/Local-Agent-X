// Gets a chat's approval card in front of the person it asks, by where they
// are (Peter, 2026-11-08):
//
//   - LAX is the focused window: the card in the chat is enough; nothing else.
//   - The computer is in use but LAX is behind another window or minimized:
//     a desktop toast and a flashing taskbar button. Clicking the toast brings
//     LAX to the front on the card. Approve and Deny stay in LAX.
//   - Nobody has touched the keyboard or mouse for PHONE_AFTER_IDLE_MS while
//     the card waits: the server copies the card to the inbox, which alerts
//     the phone (src/inbox/live-approval.ts), where it can be answered.
//
// Nothing goes to the phone while the computer is in use, and a card answered
// within TOAST_GRACE_MS raises no toast at all. However the card settles
// (answered here or on the phone, expired, dismissed by a chat reply), the
// renderer reports it and the toast closes; the server closes the phone's copy.
//
// The renderer reports cards (preload `approvalPending` / `approvalSettled`);
// this module decides on each tick. Its effects are injected so the rule is
// tested without Electron.

/** A card answered within this long never raises a toast. */
export const TOAST_GRACE_MS = 3_000;
/** How long the card and the computer have both been idle before the phone is told. */
export const PHONE_AFTER_IDLE_MS = 60_000;
/** How often pending cards are re-judged. */
export const PRESENCE_TICK_MS = 2_000;

export interface PendingCard {
  approvalId: string;
  sessionId: string;
  /** The card's sentence, for the toast. */
  context: string;
  toolName: string;
  /** When the server auto-denies it (epoch ms). Past this the card is dropped
   *  even if no settle was reported (its turn was torn down). */
  expiresAt?: number;
}

export interface Closable { close(): void }

export interface PresenceDeps {
  now(): number;
  /** LAX's main window is visible, not minimized, and focused. */
  inFront(): boolean;
  /** Milliseconds since the last keyboard or mouse input anywhere on the computer. */
  idleMs(): number;
  /** Raise the toast; its click brings LAX forward on this card. */
  toast(card: PendingCard): Closable | null;
  /** Flash (or stop flashing) LAX's taskbar button. */
  flash(on: boolean): void;
  /** Ask the server to copy this card to the inbox for the phone. */
  sendAway(approvalId: string): void;
}

interface Tracked { card: PendingCard; since: number; toast: Closable | null; toasted: boolean; away: boolean }

export interface ApprovalPresence {
  pending(card: PendingCard): void;
  settled(approvalId: string): void;
  tick(): void;
  size(): number;
}

export function createApprovalPresence(deps: PresenceDeps): ApprovalPresence {
  const cards = new Map<string, Tracked>();
  let flashing = false;
  const setFlash = (on: boolean) => {
    if (on === flashing) return;
    flashing = on;
    deps.flash(on);
  };

  const settled = (approvalId: string) => {
    const t = cards.get(approvalId);
    if (!t) return;
    cards.delete(approvalId);
    try { t.toast?.close(); } catch { /* an already-dismissed toast */ }
    if (cards.size === 0) setFlash(false);
  };

  return {
    pending(card) {
      if (!card.approvalId || cards.has(card.approvalId)) return;
      cards.set(card.approvalId, { card, since: deps.now(), toast: null, toasted: false, away: false });
    },
    settled,
    tick() {
      if (cards.size === 0) return;
      const now = deps.now();
      for (const t of [...cards.values()]) {
        if (typeof t.card.expiresAt === "number" && now > t.card.expiresAt) settled(t.card.approvalId);
      }
      if (cards.size === 0) return;
      const front = deps.inFront();
      // Looking at LAX: the card is on screen, so the taskbar stops asking.
      if (front) setFlash(false);
      for (const t of cards.values()) {
        const age = now - t.since;
        if (!front && !t.toasted && age >= TOAST_GRACE_MS) {
          t.toasted = true;
          t.toast = deps.toast(t.card);
          setFlash(true);
        }
        if (!t.away && age >= PHONE_AFTER_IDLE_MS && deps.idleMs() >= PHONE_AFTER_IDLE_MS) {
          t.away = true;
          deps.sendAway(t.card.approvalId);
        }
      }
    },
    size: () => cards.size,
  };
}
