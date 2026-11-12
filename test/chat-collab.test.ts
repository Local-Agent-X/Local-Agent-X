// @vitest-environment happy-dom
//
// The collab card and strip on the chat page (public/js/chat-collab.js,
// ADR 0007 §9): a collab starts from an ordinary chat, nothing runs until
// Start, and the chat shows where its collab is.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../public/js/chat-collab.js"), "utf8");

type Chat = { id: string; title: string; mode?: string; messages: unknown[]; startedFrom?: string };
type View = { id: string; hostId: string; question: string; steps: number; depth: string; phase: string; disputeRound: number; state: string; note: string;
  claims: number; disputed: number; chatIds: string[];
  members: Array<{ sessionId: string; label: string; provider: string; model: string; reported: boolean; dropped: string }> };
type Api = {
  of: (id: string) => View | null; open: () => void; takeCommand: () => boolean; refresh: () => Promise<void>;
  statusText: (c: View) => string; costText: (members: number, steps: number, depth: string) => string;
  defaultPicks: (providers: Array<{ id: string }>, current: { provider: string } | null) => string[];
};

const view = (over: Partial<View> = {}): View => ({
  id: "collab-1", hostId: "host", question: "Which battery?", steps: 3, depth: "standard", phase: "research", disputeRound: 0, state: "running", note: "",
  claims: 0, disputed: 0, chatIds: ["host", "m1", "m2"],
  members: [
    { sessionId: "m1", label: "opus", provider: "anthropic", model: "opus", reported: false, dropped: "" },
    { sessionId: "m2", label: "grok", provider: "xai", model: "grok", reported: false, dropped: "" },
  ],
  ...over,
});
const providers = { current: { provider: "xai", model: "grok" }, providers: [
  { id: "anthropic", name: "Claude", models: ["opus", "sonnet"] }, { id: "xai", name: "Grok", models: ["grok"] },
  { id: "codex", name: "Codex", models: ["gpt"] }, { id: "cerebras", name: "Cerebras", models: ["fast"] },
] };

describe("the collab card on the chat page", () => {
  let chats: Chat[];
  let onRecord: View[];
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let startAnswer: { ok: boolean; data: Record<string, unknown> };
  let api: Api;
  const tiles = { onChatChanged: vi.fn(), showGroup: vi.fn() };
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const apiFetch = vi.fn(async (url: string, opts?: { body?: string }) => {
    if (opts?.body) posts.push({ url, body: JSON.parse(opts.body) });
    const data = url === "/api/collab" ? { collabs: onRecord } : url.startsWith("/api/providers") ? providers : url === "/api/collab/start" ? startAnswer.data : { ok: true };
    return { ok: url === "/api/collab/start" ? startAnswer.ok : true, json: async () => data };
  });
  const chatModeOf = (c: Chat | null) => (c && c.mode === "code" ? "code" : "chat");
  const load = (): Api => new Function("chats", "apiFetch", "chatModeOf", "saveChats", "renderSidebar", "syncChatsFromServer", "setInterval",
    `${src}\nreturn laxCollab;`)(chats, apiFetch, chatModeOf, () => {}, () => {}, () => {}, () => 1);
  const open = (id: string) => { (window as { activeChat?: unknown }).activeChat = chats.find((c) => c.id === id) ?? null; };
  const btn = () => document.getElementById("chat-collab-btn")!;
  const strip = () => document.getElementById("collab-strip")!;

  beforeEach(async () => {
    document.body.innerHTML = `<span id="collab-strip" style="display:none"></span><button id="chat-collab-btn" style="display:none"></button><textarea id="msg-input"></textarea>`;
    chats = [{ id: "host", title: "Host", messages: [] }, { id: "code-1", title: "Repo", mode: "code", messages: [] }, { id: "solo", title: "Solo", messages: [] }];
    onRecord = [];
    posts = [];
    startAnswer = { ok: true, data: { ok: true, collab: view(), titles: { m1: "opus: Which battery?", m2: "grok: Which battery?" } } };
    apiFetch.mockClear(); tiles.onChatChanged.mockClear(); tiles.showGroup.mockClear();
    (window as { laxChatTiles?: unknown }).laxChatTiles = tiles;
    open("solo");
    api = load();
    await flush();
  });

  it("offers Collab on an ordinary chat and not on a code session", async () => {
    expect(btn().style.display).toBe("");
    expect(strip().style.display).toBe("none");
    open("code-1");
    await api.refresh();
    expect(btn().style.display).toBe("none");
    (document.getElementById("msg-input") as HTMLTextAreaElement).value = "/collab anything";
    expect(api.takeCommand()).toBe(false);
  });

  it("says which turns a collab runs, and starts with this chat's model then one from each other provider", () => {
    expect(api.costText(3, 1, "standard")).toBe("3 research turns, then one turn in this chat to write the result. Each turn is billed to that model’s account.");
    expect(api.costText(3, 3, "deep")).toContain("3 research turns (deep: each takes longer), then 3 turns checking each other’s claims, then up to 9 short turns answering challenges and settling what is still disputed, then one turn in this chat");
    expect(api.defaultPicks(providers.providers, providers.current)).toEqual(["xai", "anthropic", "codex"]);
  });

  it("/collab opens the card with the question; nothing starts until Start, which makes the member chats and tiles them", async () => {
    open("host");
    (document.getElementById("msg-input") as HTMLTextAreaElement).value = "/collab Which battery?";
    expect(api.takeCommand()).toBe(true);
    await flush();
    const card = document.getElementById("collab-card")!;
    expect((card.querySelector(".collab-question") as HTMLTextAreaElement).value).toBe("Which battery?");
    expect(posts).toEqual([]);
    const checked = [...card.querySelectorAll<HTMLInputElement>(".collab-member input")].filter((b) => b.checked).map((b) => b.dataset.provider);
    expect(checked).toEqual(["anthropic", "xai", "codex"]);
    expect([...card.querySelectorAll<HTMLSelectElement>(".collab-choice select")].map((x) => x.value)).toEqual(["3", "standard"]);
    expect(card.textContent).toContain("up to 9 short turns answering challenges");
    const depth = card.querySelectorAll<HTMLSelectElement>(".collab-choice select")[1];
    depth.value = "deep";
    depth.dispatchEvent(new Event("change", { bubbles: true }));
    expect(card.textContent).toContain("(deep: each takes longer)");

    [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Start")!.click();
    await flush();
    expect(posts).toEqual([{ url: "/api/collab/start", body: { sessionId: "host", question: "Which battery?", steps: 3, depth: "deep",
      members: [{ provider: "anthropic", model: "opus" }, { provider: "xai", model: "grok" }, { provider: "codex", model: "gpt" }] } }]);
    expect(document.getElementById("collab-card")).toBeNull();
    expect(chats.filter((c) => c.startedFrom === "host").map((c) => c.title).sort()).toEqual(["grok: Which battery?", "opus: Which battery?"]);
    expect(tiles.showGroup).toHaveBeenCalled();
    expect(api.of("m2")?.id).toBe("collab-1");
    expect(strip().textContent).toContain("Collab: 2 models researching");
    // The host waits for the collab it is running; a member's chat never offers one.
    expect(btn().style.display).toBe("none");
  });

  it("keeps the card open and says why when the server refuses", async () => {
    open("host");
    startAnswer = { ok: false, data: { error: "Grok is not signed in, so it cannot join." } };
    api.open();
    await flush();
    const card = document.getElementById("collab-card")!;
    (card.querySelector(".collab-question") as HTMLTextAreaElement).value = "Q";
    card.querySelector(".collab-question")!.dispatchEvent(new Event("input"));
    [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Start")!.click();
    await flush();
    expect(document.getElementById("collab-card")).not.toBeNull();
    expect(card.querySelector(".collab-card-error")!.textContent).toBe("Grok is not signed in, so it cannot join.");
  });

  it("the strip follows the collab, and Stop asks the server to stop it", async () => {
    open("host");
    onRecord = [view({ phase: "challenge" })];
    await api.refresh();
    expect(strip().textContent).toContain("Collab: 2 models checking each other’s claims");
    strip().querySelector("button")!.click();
    await flush();
    expect(posts).toEqual([{ url: "/api/collab/stop", body: { id: "collab-1" } }]);

    expect(api.statusText(view({ phase: "answer", disputed: 1 }))).toBe("Collab: answering 1 challenge");
    expect(api.statusText(view({ phase: "dispute", disputed: 2, disputeRound: 1 }))).toBe("Collab: settling 2 disputes, round 1 of 2");
    expect(api.statusText(view({ phase: "writing" }))).toBe("Collab: writing the result");
    expect(api.statusText(view({ state: "done" }))).toBe("Collab finished");
    expect(api.statusText(view({ state: "done", note: "The result does not name this open dispute: A2." }))).toBe("Collab finished: The result does not name this open dispute: A2.");
    expect(api.statusText(view({ state: "stopped", note: "Stopped by the user." }))).toBe("Collab stopped: Stopped by the user.");
    onRecord = [view({ state: "done" })];
    await api.refresh();
    expect(strip().querySelector("button")).toBeNull();
    // Finished: the host may start another.
    expect(btn().style.display).toBe("");
  });
});
