// Rating an alert teaches the mail watcher: the rating is counted per sender
// and kind, the model is shown it, and a sender twice "not important" (and
// never "useful") goes to the digest, a travel change excepted.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../event-bus.js";
import { inboxStore, listInbox } from "../../inbox/index.js";
import { inboxImportantMail, mailAlertKey } from "../../inbox/producers.js";
import { categoryRecord, demoted, listenForRatings, loadRatings, noteAlert, senderRecord } from "./mail-watch-ratings.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-ratings-")); process.env.LAX_DATA_DIR = dir; listenForRatings(); });
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("rating mail alerts", () => {
  it("an alert offers a rating; rating it counts for its sender and kind", async () => {
    inboxImportantMail({ account: "me", id: "<1@x>", from: "Deals <deals@shop.com>", subject: "Sale", why: "money", travel: false });
    noteAlert(mailAlertKey("me", "<1@x>"), "deals@shop.com", "money", Date.now());
    const item = listInbox().items[0]!;
    expect(item.feedback).toBe("unrated");
    const rated = inboxStore().rate(item.id, "not-useful")!;
    expect(rated.feedback).toBe("not-useful");
    expect(rated.readAt).toBeDefined();
    void EventBus.emit("inbox:rated", { key: rated.key!, rating: "not-useful" });
    await flush();
    const r = loadRatings();
    expect(r.senders["deals@shop.com"]).toEqual({ up: 0, down: 1 });
    expect(senderRecord(r, "deals@shop.com")).toBe("not important 1×");
    expect(categoryRecord(r)).toContain("money: useful 0×, not important 1×");
  });

  it("twice not important and never useful demotes a sender; one useful keeps them", async () => {
    for (const n of [1, 2]) {
      noteAlert(`mail:me:<${n}@x>`, "deals@shop.com", "money", n);
      void EventBus.emit("inbox:rated", { key: `mail:me:<${n}@x>`, rating: "not-useful" });
    }
    await flush();
    expect(demoted(loadRatings(), "deals@shop.com")).toBe(true);
    noteAlert("mail:me:<3@x>", "deals@shop.com", "money", 3);
    void EventBus.emit("inbox:rated", { key: "mail:me:<3@x>", rating: "useful" });
    await flush();
    expect(demoted(loadRatings(), "deals@shop.com")).toBe(false);
  });

  it("an item that offers no rating cannot be rated", () => {
    const item = inboxStore().post({ kind: "notice", title: "t", body: "", needsYou: false }).item;
    expect(inboxStore().rate(item.id, "useful")).toBeNull();
  });
});
