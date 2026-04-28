/**
 * Native browser dialogs (alert/confirm/prompt/beforeunload) live outside the
 * DOM — Playwright surfaces them as a `dialog` event. If nobody handles the
 * event, the page hangs forever. We register a passive handler that captures
 * the dialog text, queues it, and waits for the agent to call dialog_accept
 * or dialog_dismiss on the next turn. Never auto-accept silently — agents
 * should be aware they're acknowledging a confirmation.
 */
import type { Dialog, Page } from "playwright";

export interface CapturedDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue: string;
}

interface DialogQueue {
  pending: { dialog: Dialog; info: CapturedDialog }[];
  installed: boolean;
}

const queues = new WeakMap<Page, DialogQueue>();

export function installDialogHandler(page: Page): void {
  let q = queues.get(page);
  if (q?.installed) return;
  q = { pending: [], installed: true };
  queues.set(page, q);

  page.on("dialog", (dialog) => {
    const queue = queues.get(page);
    if (!queue) {
      // Page was closed but handler still firing — auto-dismiss to unblock.
      dialog.dismiss().catch(() => {});
      return;
    }
    queue.pending.push({
      dialog,
      info: {
        type: dialog.type() as CapturedDialog["type"],
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
      },
    });
  });

  page.on("close", () => {
    const queue = queues.get(page);
    if (!queue) return;
    for (const p of queue.pending) {
      p.dialog.dismiss().catch(() => {});
    }
    queues.delete(page);
  });
}

export function pendingDialogs(page: Page): CapturedDialog[] {
  return (queues.get(page)?.pending ?? []).map((p) => p.info);
}

export async function handleNextDialog(
  page: Page,
  action: "accept" | "dismiss",
  promptText?: string
): Promise<string> {
  const q = queues.get(page);
  if (!q || q.pending.length === 0) {
    return "No native dialog pending.";
  }
  const next = q.pending.shift()!;
  try {
    if (action === "accept") {
      await next.dialog.accept(promptText ?? next.info.defaultValue);
      return `Accepted ${next.info.type} dialog: "${next.info.message.slice(0, 80)}"`;
    }
    await next.dialog.dismiss();
    return `Dismissed ${next.info.type} dialog: "${next.info.message.slice(0, 80)}"`;
  } catch (e) {
    return `Failed to ${action} dialog: ${(e as Error).message}`;
  }
}
