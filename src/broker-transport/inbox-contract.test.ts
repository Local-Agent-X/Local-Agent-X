// The desktop's inbox frames against the phone's half of the contract
// (vendor/inbox.ts). Like workers-contract.test.ts the shape checks are
// compile-time: `npm run build` typechecks this file, so an inbox item or frame
// an installed phone would drop or misread fails the build.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxFrame, InboxItem } from "../inbox/types.js";
import type { InboxChangedFrame, InboxItem as PhoneInboxItem, InboxItemFrame } from "./vendor/protocol.js";
import { parseInboxSnapshot, parseInboxUpdate } from "./vendor/protocol.js";

/** Every item the desktop stores is one the phone reads whole. */
const itemFits: [InboxItem] extends [PhoneInboxItem] ? true : false = true;
/** Every live frame the bell reads is one the phone reads. */
const framesFit: [InboxFrame] extends [InboxItemFrame | InboxChangedFrame] ? true : false = true;
void itemFits;
void framesFit;

const prev = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-inbox-contract-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

describe("inbox contract with the phone", () => {
  it("the snapshot the desktop sends parses whole on the phone, with the server-only fields gone", async () => {
    const { inboxStore } = await import("../inbox/index.js");
    const { buildInboxSnapshot } = await import("../chat-ws/inbox-frames.js");
    inboxStore().post({
      kind: "approval", title: "Nightly sync wants to run bash", body: "Tool: bash", needsYou: true, key: "approval:cron:x",
      actions: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }], link: { sessionId: "cron-nightly" },
      deferredCall: { toolName: "bash", args: { command: "echo hi" }, callContext: "cron", reason: "BLOCKED", jobLabel: "Nightly sync" },
    });
    inboxStore().post({ kind: "notice", title: "Spend caps are now on by default", body: "", needsYou: false, key: "notice:spend" });
    const frame = buildInboxSnapshot();
    const parsed = parseInboxSnapshot(JSON.parse(JSON.stringify(frame)));
    expect(parsed).toEqual({ ...frame, type: "inbox_snapshot" });
    expect(parsed!.items.map((i) => i.kind)).toEqual(["approval", "notice"]);
    expect(JSON.stringify(frame)).not.toMatch(/deferredCall|"key"|dismissedAt/);
  });

  it("each change the desktop broadcasts is read as that change on the phone", async () => {
    const { inboxStore, toInboxView } = await import("../inbox/index.js");
    const posted = inboxStore().post({ kind: "job", title: "Build finished", body: "ok", needsYou: false, link: { url: "/apps/habits/" } });
    const item = toInboxView(posted.item);
    const counts = inboxStore().counts();
    const added: InboxFrame = { type: "inbox_item", item, created: true, ...counts };
    expect(parseInboxUpdate(added)).toEqual({ kind: "added", item, counts });
    const changed: InboxFrame = { type: "inbox_changed", action: "read", id: item.id, item: { ...item, readAt: 5 }, ...counts };
    expect(parseInboxUpdate(changed)).toEqual({ kind: "changed", item: { ...item, readAt: 5 }, counts });
    const removed: InboxFrame = { type: "inbox_changed", action: "dismiss", id: item.id, ...counts };
    expect(parseInboxUpdate(removed)).toEqual({ kind: "removed", id: item.id, counts });
    const all: InboxFrame = { type: "inbox_changed", action: "read_all", ...counts };
    expect(parseInboxUpdate(all)).toEqual({ kind: "read_all", counts });
    const resolvedElsewhere: InboxFrame = { type: "inbox_changed", action: "resolve", ...counts };
    expect(parseInboxUpdate(resolvedElsewhere)).toEqual({ kind: "stale", counts });
  });
});
