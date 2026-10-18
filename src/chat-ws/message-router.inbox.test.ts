// The phone's inbox frames (inbox_list / inbox_read / inbox_act) on the chat
// socket. The snapshot is the store's visible list in the shape the phone
// parses; an answer lands on the SAME route functions a click in the bell
// runs (routes/inbox.ts): Approve dispatches the stored call once through the
// pipeline, Decline closes it, read / dismiss / resolve apply and broadcast,
// and a refusal comes back as the top-level error frame the phone reads.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { ServerContext } from "../server-context.js";
import type { ToolDefinition } from "../types.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
let shellRuns: string[];

const { attachMessageRouter } = await import("./message-router.js");
const { setInboxAnswerer } = await import("./inbox-frames.js");
const { actOnInbox, mutateInbox } = await import("../routes/inbox.js");
const { inboxStore } = await import("../inbox/index.js");
const { inboxApprovalRequest } = await import("../inbox/approvals.js");
const { setAriRequired } = await import("../ari-kernel/state.js");
const { parseInboxSnapshot, parseControlError, parseInboxUpdate } = await import("../broker-transport/vendor/protocol.js");

const bash = {
  name: "bash", description: "stub", parameters: { type: "object", properties: {} },
  execute: async (args: Record<string, unknown>) => { shellRuns.push(String(args.command)); return { content: `ran ${String(args.command)}` }; },
} as unknown as ToolDefinition;

let broadcastAll: ReturnType<typeof vi.fn>;

beforeAll(() => setAriRequired(false));
afterAll(() => { setAriRequired(true); setInboxAnswerer(null); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-inbox-ws-"));
  mkdirSync(join(dir, "workspace"));
  process.env.LAX_DATA_DIR = dir;
  shellRuns = [];
  broadcastAll = vi.fn();
  // The server's registration, with the same context the HTTP route gets.
  const ctx = {
    broadcastAll, allAgentTools: [bash], config: { workspace: join(dir, "workspace") }, dataDir: dir,
    getActiveOnEvent: () => undefined,
  } as unknown as ServerContext;
  setInboxAnswerer({
    mutate: (action, id) => mutateInbox(ctx, action, id) !== null,
    act: (id, action) => actOnInbox(ctx, id, action),
  });
});
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

async function ask(frame: Record<string, unknown>): Promise<unknown[]> {
  const sent: string[] = [];
  let onMessage: ((data: Buffer) => unknown) | null = null;
  const ws = {
    readyState: 1,
    send: (out: string) => { sent.push(out); },
    on: (evt: string, cb: (data: Buffer) => unknown) => { if (evt === "message") onMessage = cb; },
  } as unknown as WebSocket;
  attachMessageRouter({ ws, subscriptions: new Set<string>() });
  await onMessage!(Buffer.from(JSON.stringify(frame)));
  return sent.map((out) => JSON.parse(out) as unknown);
}

function park() {
  return inboxApprovalRequest({
    toolName: "bash", args: { command: "echo hi" }, callContext: "api", reason: "BLOCKED (unattended): bash cannot execute in this api context.",
    jobLabel: "Background task \"nightly sync\"", sessionId: "api-nightly-1",
  })!;
}

const broadcasts = () => broadcastAll.mock.calls.map((c) => c[0] as Record<string, unknown>);

describe("inbox_list", () => {
  it("answers with every visible item and the counts, in the shape the phone parses", async () => {
    const parked = park();
    inboxStore().post({ kind: "job", title: "Build finished", body: "Built it", needsYou: false, link: { url: "/apps/habits/", opId: "op_1" } });
    const frames = await ask({ type: "inbox_list" });
    const snapshot = frames.map(parseInboxSnapshot).find((f) => f !== null);
    expect(snapshot).toMatchObject({ type: "inbox_snapshot", unread: 2, needsYou: 1 });
    expect(snapshot!.items.map((i) => i.kind)).toEqual(["approval", "job"]); // needs-you first
    expect(snapshot!.items[0]).toMatchObject({ id: parked.id, needsYou: true, actions: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] });
    expect(snapshot!.items[1]!.link).toEqual({ url: "/apps/habits/", opId: "op_1" });
    expect(JSON.stringify(frames)).not.toContain("deferredCall");
  });
});

describe("inbox_read", () => {
  it("marks one item read and broadcasts the item's new state; without an id, every item", async () => {
    const parked = park();
    const other = inboxStore().post({ kind: "job", title: "t", body: "", needsYou: false }).item;
    expect(await ask({ type: "inbox_read", id: parked.id })).toEqual([]);
    expect(inboxStore().get(parked.id)?.readAt).toBeDefined();
    expect(parseInboxUpdate(broadcasts()[0])).toMatchObject({ kind: "changed", item: { id: parked.id } });
    await ask({ type: "inbox_read" });
    expect(inboxStore().get(other.id)?.readAt).toBeDefined();
    expect(parseInboxUpdate(broadcasts()[1])).toMatchObject({ kind: "read_all", counts: { unread: 0 } });
  });

  it("an unknown id is refused with the error frame the phone reads", async () => {
    const [reply] = await ask({ type: "inbox_read", id: "inb_nope" });
    expect(parseControlError(reply)).toBe("No such inbox item (inb_nope)");
  });
});

describe("inbox_act", () => {
  it("approve runs the stored call once through the pipeline and reports the outcome as a new item", async () => {
    const parked = park();
    expect(await ask({ type: "inbox_act", id: parked.id, action: "approve" })).toEqual([]);
    expect(shellRuns).toEqual(["echo hi"]);
    expect(inboxStore().get(parked.id)).toMatchObject({ resolution: "approved" });
    expect(parseInboxUpdate(broadcasts()[0])).toMatchObject({ kind: "changed", item: { id: parked.id, resolution: "approved" } });
    // The outcome is its own item (its inbox_item frame rides the real broadcastAll).
    expect(inboxStore().list().map((i) => [i.kind, i.title])).toContainEqual(["job", "Your approved bash call ran"]);
    // A second answer, from any screen, runs nothing.
    const [refused] = await ask({ type: "inbox_act", id: parked.id, action: "approve" });
    expect(parseControlError(refused)).toBe("That approval was already answered");
    expect(shellRuns).toEqual(["echo hi"]);
  });

  it("decline runs nothing, closes the item and broadcasts", async () => {
    const parked = park();
    expect(await ask({ type: "inbox_act", id: parked.id, action: "decline" })).toEqual([]);
    expect(shellRuns).toEqual([]);
    expect(inboxStore().get(parked.id)).toMatchObject({ resolution: "declined" });
    expect(parseInboxUpdate(broadcasts()[0])).toMatchObject({ kind: "changed", item: { id: parked.id, resolution: "declined" } });
  });

  it("dismiss hides the item and broadcasts a removal; resolve marks it done", async () => {
    const job = inboxStore().post({ kind: "job", title: "Build failed", body: "", needsYou: true }).item;
    await ask({ type: "inbox_act", id: job.id, action: "resolve" });
    expect(parseInboxUpdate(broadcasts()[0])).toMatchObject({ kind: "changed", item: { id: job.id, needsYou: true } });
    expect(inboxStore().get(job.id)?.resolvedAt).toBeDefined();
    await ask({ type: "inbox_act", id: job.id, action: "dismiss" });
    expect(parseInboxUpdate(broadcasts()[1])).toMatchObject({ kind: "removed", id: job.id });
    expect(inboxStore().list()).toEqual([]);
  });

  it("a malformed act, an unknown id and an item that is not an approval are refused", async () => {
    const job = inboxStore().post({ kind: "job", title: "t", body: "", needsYou: false }).item;
    expect(parseControlError((await ask({ type: "inbox_act", id: job.id, action: "explode" }))[0])).toContain("inbox_act needs an id and an action");
    expect(parseControlError((await ask({ type: "inbox_act", id: "inb_nope", action: "approve" }))[0])).toBe("No such inbox item");
    expect(parseControlError((await ask({ type: "inbox_act", id: job.id, action: "approve" }))[0])).toBe("That item is not waiting for an approval");
    expect(shellRuns).toEqual([]);
  });

  it("before the server registers its answerer, an answer is refused, never dropped", async () => {
    setInboxAnswerer(null);
    const parked = park();
    const [reply] = await ask({ type: "inbox_act", id: parked.id, action: "approve" });
    expect(parseControlError(reply)).toContain("cannot be answered yet");
    expect(shellRuns).toEqual([]);
  });
});
