// Phone alerts: a phone's registration, what reaches Expo (sealed data only),
// which items ring which phone, and what a dead token or a failure does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUSH_AAD, parsePushAlert, type SealedPushData } from "../broker-transport/vendor/protocol.js";
import type { InboxItem } from "../inbox/types.js";
import { createPhonePushStore, MAX_PHONES } from "./store.js";
import { sealPushAlert } from "./seal.js";
import { sendExpoPush, type ExpoPushMessage, type PushTicket } from "./send.js";
import { alertPhones, handlePushFrame, type AlertDeps } from "./index.js";

const token = (n: number) => `ExponentPushToken[phone${n}]`;
const newKey = () => randomBytes(32).toString("base64");
const masterKey = randomBytes(32);

function open(sealed: SealedPushData, keyB64: string): unknown {
  const raw = Buffer.from(sealed.c, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), Buffer.from(sealed.n, "base64"));
  decipher.setAAD(Buffer.from(PUSH_AAD, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8"));
}

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: "inb_1", kind: "agent-message", title: "Ada needs you", body: "The deploy is waiting on your call.", createdAt: 1, needsYou: true, ...over,
});

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-phone-push-")); file = join(dir, "phone-push.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("seal", () => {
  it("opens only with the phone's key, and holds the alert", () => {
    const key = newKey();
    const sealed = sealPushAlert({ id: "inb_1", kind: "agent-message", title: "t", body: "b" }, key);
    expect(parsePushAlert(open(sealed, key))).toEqual({ id: "inb_1", kind: "agent-message", title: "t", body: "b" });
    expect(() => open(sealed, newKey())).toThrow();
  });

  it("uses a fresh nonce every time", () => {
    const key = newKey();
    const alert = { id: "i", kind: "job" as const, title: "t", body: "b" };
    expect(sealPushAlert(alert, key).n).not.toBe(sealPushAlert(alert, key).n);
  });
});

describe("store", () => {
  it("keeps a phone's key encrypted on disk and opens it in memory", () => {
    const store = createPhonePushStore(file, () => masterKey);
    const key = newKey();
    store.register({ token: token(1), key, kinds: ["agent-message"], device: "Pixel" });
    expect(readFileSync(file, "utf8")).not.toContain(key);
    expect(store.list()).toMatchObject([{ token: token(1), key, kinds: ["agent-message"], device: "Pixel" }]);
  });

  it("replaces a phone that registers again, and drops the oldest past the cap", () => {
    const store = createPhonePushStore(file, () => masterKey);
    store.register({ token: token(1), key: newKey(), kinds: ["job"] });
    store.register({ token: token(1), key: newKey(), kinds: ["approval"] });
    expect(store.list().map((p) => p.kinds)).toEqual([["approval"]]);
    for (let i = 2; i <= MAX_PHONES + 1; i++) store.register({ token: token(i), key: newKey(), kinds: [] });
    expect(store.list().map((p) => p.token)).not.toContain(token(1));
    expect(store.list()).toHaveLength(MAX_PHONES);
  });

  it("skips a phone whose key no longer opens (the master key changed)", () => {
    createPhonePushStore(file, () => masterKey).register({ token: token(1), key: newKey(), kinds: ["job"] });
    const unreadable = vi.fn();
    expect(createPhonePushStore(file, () => randomBytes(32), unreadable).list()).toEqual([]);
    expect(unreadable).toHaveBeenCalledWith(token(1));
  });
});

describe("handlePushFrame", () => {
  const socket = () => { const sent: unknown[] = []; return { sent, ws: { readyState: 1 as const, send:(s: string) => { sent.push(JSON.parse(s)); } } }; };

  it("registers a phone and answers with what it now holds", () => {
    const store = createPhonePushStore(file, () => masterKey);
    const { ws, sent } = socket();
    const key = newKey();
    expect(handlePushFrame(ws, { type: "push_register", token: token(1), key, kinds: ["approval", "agent-message"] }, store)).toBe(true);
    expect(store.list()).toMatchObject([{ token: token(1), key }]);
    expect(sent).toEqual([{ type: "push_registered", token: token(1), kinds: ["approval", "agent-message"] }]);
  });

  it("unregisters, and refuses a malformed registration without storing it", () => {
    const store = createPhonePushStore(file, () => masterKey);
    const { ws, sent } = socket();
    handlePushFrame(ws, { type: "push_register", token: token(1), key: newKey(), kinds: [] }, store);
    handlePushFrame(ws, { type: "push_unregister", token: token(1) }, store);
    expect(store.list()).toEqual([]);
    handlePushFrame(ws, { type: "push_register", token: "https://evil.example/", key: newKey(), kinds: [] }, store);
    expect(store.list()).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: "error" });
  });

  it("leaves every other frame alone", () => {
    expect(handlePushFrame(socket().ws, { type: "inbox_list" }, createPhonePushStore(file, () => masterKey))).toBe(false);
  });
});

describe("alertPhones", () => {
  function deps(over: Partial<AlertDeps> = {}) {
    const store = createPhonePushStore(file, () => masterKey);
    const sent: ExpoPushMessage[][] = [];
    const send = vi.fn(async (messages: ExpoPushMessage[]): Promise<PushTicket[]> => { sent.push(messages); return messages.map(() => ({ status: "ok" })); });
    return { store, sent, send, d: { store, send, localOnly: () => false, ...over } as AlertDeps };
  }

  it("rings only the phones that want the item's kind, with sealed data and no readable text", async () => {
    const { store, sent, d } = deps();
    const key = newKey();
    store.register({ token: token(1), key, kinds: ["agent-message"] });
    store.register({ token: token(2), key: newKey(), kinds: ["job"] });
    await alertPhones(item(), d);
    expect(sent).toHaveLength(1);
    const [message] = sent[0]!;
    expect(message).toMatchObject({ to: token(1), priority: "high" });
    expect(JSON.stringify(message)).not.toContain("Ada needs you");
    expect(parsePushAlert(open(message!.data, key))).toEqual({ id: "inb_1", kind: "agent-message", title: "Ada needs you", body: "The deploy is waiting on your call." });
  });

  it("sends nothing in local-only mode or when no phone wants the kind", async () => {
    const { store, send, d } = deps({ localOnly: () => true });
    store.register({ token: token(1), key: newKey(), kinds: ["agent-message"] });
    await alertPhones(item(), d);
    await alertPhones(item({ kind: "update" }), { ...d, localOnly: () => false });
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a phone Expo says is gone, and never throws on a failed send", async () => {
    const { store, d } = deps();
    store.register({ token: token(1), key: newKey(), kinds: ["agent-message"] });
    await alertPhones(item(), { ...d, send: async () => [{ status: "error", message: "gone", error: "DeviceNotRegistered" }] });
    expect(store.list()).toEqual([]);
    store.register({ token: token(2), key: newKey(), kinds: ["agent-message"] });
    await expect(alertPhones(item(), { ...d, send: async () => { throw new Error("offline"); } })).resolves.toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });
});

describe("sendExpoPush", () => {
  it("posts the messages to Expo and reads its tickets", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: "ok", id: "t1" }, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] })));
    const tickets = await sendExpoPush([], fetchImpl as unknown as typeof fetch);
    expect(tickets).toEqual([{ status: "ok" }, { status: "error", message: "gone", error: "DeviceNotRegistered" }]);
    expect(fetchImpl).toHaveBeenCalledWith("https://exp.host/--/api/v2/push/send", expect.objectContaining({ method: "POST" }));
  });

  it("throws on a refused request", async () => {
    const fetchImpl = async () => new Response("no", { status: 503 });
    await expect(sendExpoPush([], fetchImpl as unknown as typeof fetch)).rejects.toThrow("503");
  });
});
