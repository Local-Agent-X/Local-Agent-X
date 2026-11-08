// A chat's live approval card copied to the inbox for the phone
// (live-approval.ts): the copy answers the card itself, one answer wins, and
// the copy closes when the card settles any other way. Driven through the real
// approval manager and the real act route, so the seam between them is tested.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerContext } from "../server-context.js";
import { getApprovalManager, onApprovalSettled } from "../approval-manager.js";
import { actOnInbox } from "../routes/inbox.js";
import { inboxStore, listInbox } from "./index.js";
import { inboxLiveApproval, settleLiveApproval } from "./live-approval.js";

let dir: string;
let unlisten: () => void;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-live-approval-"));
  process.env.LAX_DATA_DIR = dir;
  // As server/index.ts wires it at boot.
  unlisten = onApprovalSettled((id) => { settleLiveApproval(id); });
});
afterEach(() => {
  unlisten();
  getApprovalManager().clearSession("chat-live");
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = { broadcastAll: vi.fn() } as unknown as ServerContext;
const CONTEXT = "Sending key.json (it contains GCP Service Account) to expo.dev needs your approval.";

/** A live card, as a chat turn raises it, and its copy in the inbox. */
async function liveCard(args: Record<string, unknown> = { action: "upload", ref: 3 }) {
  const events: Array<{ type: string }> = [];
  const outcome = getApprovalManager().requestApprovalDetailed({
    toolName: "browser", toolCallId: "t1", sessionId: "chat-live", context: CONTEXT, args, alwaysAsk: true,
    emit: (e) => { events.push(e as { type: string }); },
  });
  await vi.waitFor(() => expect(events.some((e) => e.type === "approval_requested")).toBe(true));
  const approvalId = (events.find((e) => e.type === "approval_requested") as unknown as { approvalId: string }).approvalId;
  const card = getApprovalManager().pendingCard(approvalId);
  expect(card).toEqual({ sessionId: "chat-live", toolName: "browser", context: CONTEXT });
  const item = inboxLiveApproval({ approvalId, ...card! });
  return { outcome, approvalId, item: item!, events };
}

describe("a live approval card's inbox copy", () => {
  it("carries the card's sentence and Approve/Decline, and never shows the card id to a client", async () => {
    const { item } = await liveCard();
    expect(item.kind).toBe("approval");
    expect(item.body).toContain(CONTEXT);
    expect(item.actions?.map((a) => a.id)).toEqual(["approve", "decline"]);
    expect(item.link).toEqual({ sessionId: "chat-live" });
    expect(JSON.stringify(listInbox())).not.toContain("liveApprovalId");
  });

  it("Approve on the phone approves the chat card, once", async () => {
    const { outcome, item, events } = await liveCard();
    const answer = await actOnInbox(ctx, item.id, "approve");
    expect(answer).toEqual({ ok: true, resolution: "approved" });
    expect((await outcome).approved).toBe(true);
    expect(events.some((e) => e.type === "approval_resolved")).toBe(true);
    // A second answer (another device, a double tap) is refused.
    expect(await actOnInbox(ctx, item.id, "decline")).toEqual({ ok: false, refused: "answered" });
  });

  it("Decline on the phone declines the chat card", async () => {
    const { outcome, item } = await liveCard({ action: "upload", ref: 4 });
    expect(await actOnInbox(ctx, item.id, "decline")).toEqual({ ok: true, resolution: "declined" });
    expect(await outcome).toMatchObject({ approved: false, reason: "declined" });
  });

  it("a click at the desk closes the copy, so the phone stops asking", async () => {
    const { approvalId, item } = await liveCard({ action: "upload", ref: 5 });
    expect(getApprovalManager().resolveApproval(approvalId, true)).toBe(true);
    expect(inboxStore().get(item.id)?.resolvedAt).toBeTypeOf("number");
  });

  it("a card that ended some other way closes its copy, and a late answer changes nothing", async () => {
    const { item } = await liveCard({ action: "upload", ref: 6 });
    getApprovalManager().denyPendingForSession("chat-live"); // the user replied in chat instead
    expect(inboxStore().get(item.id)?.resolvedAt).toBeTypeOf("number");
    expect(await actOnInbox(ctx, item.id, "approve")).toEqual({ ok: false, refused: "answered" });
  });
});
