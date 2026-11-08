// A NEW inbox item is announced on the bus (inbox:posted), once; a repeat of a
// keyed item that changes nothing is not news. The phone alerts listen there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../chat-ws/broadcast.js", () => ({ broadcastAll: vi.fn() }));

import { EventBus } from "../event-bus.js";
import { postToInbox } from "./index.js";
import type { InboxItem } from "./types.js";

let dir: string;
let prev: string | undefined;
const heard: InboxItem[] = [];
const listener = ({ item }: { item: InboxItem }) => { heard.push(item); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-inbox-posted-"));
  prev = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = dir;
  heard.length = 0;
  EventBus.on("inbox:posted", listener);
});
afterEach(() => {
  EventBus.off("inbox:posted", listener);
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("inbox:posted", () => {
  it("fires for a new item with its client view, and not for an unchanged repeat", async () => {
    const posted = postToInbox({ kind: "agent-message", title: "Ada needs you", body: "help", needsYou: true, key: "k1" });
    postToInbox({ kind: "agent-message", title: "Ada needs you", body: "help", needsYou: true, key: "k1" });
    await Promise.resolve();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toEqual(posted);
    expect(heard[0]).not.toHaveProperty("key");
  });
});
