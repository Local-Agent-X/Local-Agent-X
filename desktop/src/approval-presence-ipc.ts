// Wires approval-presence.ts to Electron: the renderer's card reports in, a
// toast and taskbar flash out, the system idle clock, and the server message
// that sends the card to the phone. The rule itself lives in approval-presence.ts.

import { ipcMain, powerMonitor } from "electron";
import { createApprovalPresence, PRESENCE_TICK_MS, type PendingCard } from "./approval-presence";
import { showNotification } from "./hotkey-notifications";
import { approvalAwayToServer } from "./server-process";
import { getMainWindow, mainWindowInFront } from "./window";

const TOAST_BODY_MAX = 180;

function isCard(raw: unknown): raw is PendingCard {
  const c = raw as Partial<PendingCard> | null;
  return !!c && typeof c.approvalId === "string" && c.approvalId !== "" && typeof c.sessionId === "string"
    && typeof c.context === "string" && typeof c.toolName === "string";
}

export function setupApprovalPresenceIPC(): void {
  const presence = createApprovalPresence({
    now: () => Date.now(),
    inFront: mainWindowInFront,
    idleMs: () => powerMonitor.getSystemIdleTime() * 1_000,
    toast: (card) => {
      const body = card.context.length > TOAST_BODY_MAX ? `${card.context.slice(0, TOAST_BODY_MAX - 1)}…` : card.context;
      // The click brings LAX forward (showNotification), then the chat opens on the card.
      return showNotification("Approval needed", body, () => {
        getMainWindow()?.webContents.send("focus-approval", { approvalId: card.approvalId, sessionId: card.sessionId });
      });
    },
    flash: (on) => { getMainWindow()?.flashFrame(on); },
    sendAway: approvalAwayToServer,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  const schedule = () => {
    if (presence.size() > 0 && !timer) timer = setInterval(() => presence.tick(), PRESENCE_TICK_MS);
    if (presence.size() === 0 && timer) { clearInterval(timer); timer = null; }
  };

  ipcMain.handle("approval-pending", (_e, raw: unknown) => {
    if (!isCard(raw)) return;
    presence.pending({
      approvalId: raw.approvalId, sessionId: raw.sessionId, context: raw.context, toolName: raw.toolName,
      ...(typeof raw.expiresAt === "number" ? { expiresAt: raw.expiresAt } : {}),
    });
    schedule();
  });
  ipcMain.handle("approval-settled", (_e, approvalId: unknown) => {
    if (typeof approvalId !== "string") return;
    presence.settled(approvalId);
    schedule();
  });
}
