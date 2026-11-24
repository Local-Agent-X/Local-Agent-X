// An app's conversations with the user's agents, over the real listeners: the
// app's own origin admits the calls with that app's capability and nothing
// else, every call waits on the user's yes for that app, and the yes is given
// (and taken back) only by the user.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerContext } from "../server-context.js";
import type { LAXConfig } from "../types.js";
import type { Role } from "../rbac.js";

const turns = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  script: (async () => {}) as (args: { sseSink: (e: unknown) => void }) => Promise<void>,
}));
vi.mock("./chat/run-chat-turn.js", () => ({
  runChatTurn: async (args: Record<string, unknown> & { sseSink: (e: unknown) => void }) => {
    turns.calls.push(args);
    await turns.script(args);
  },
}));

const { agentOrigin, startAgentOrigin } = await import("../server/agent-origin.js");
const { ensureAppOrigin } = await import("../server/app-origins.js");
const { deriveAppChatCapability, deriveAppDataCapability, deriveConnectorCapability } = await import("../server/app-connector-auth.js");
const { appChatSessionId } = await import("../server/app-chat-turn.js");
const { appChatAnswer, listAppChatGrants, recordAppChatAnswer } = await import("../app-runtime/chat-grants.js");
const { inboxStore, listInbox } = await import("../inbox/index.js");
const { handleInboxRoutes } = await import("./inbox.js");
const { handleAppChatGrantRoutes } = await import("./app-chat.js");

const OP_TOKEN = "op-token-" + "0123456789abcdef0123456789abcdef";
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const prevDataDir = process.env.LAX_DATA_DIR;

let root: string;
let agentServer: Server;
let broadcastAll: ReturnType<typeof vi.fn<(frame: unknown) => void>>;
let stored: Record<string, { id: string; title: string; messages: Array<{ role: string; content: string }>; createdAt: number; updatedAt: number }>;
let ctx: ServerContext;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "app-chat-"));
  const workspace = join(root, "workspace");
  for (const id of ["hub", "other"]) {
    mkdirSync(join(workspace, "apps", id), { recursive: true });
    writeFileSync(join(workspace, "apps", id, "index.html"), `<!doctype html><html><head><title>${id}</title></head><body>app</body></html>`);
  }
  const config = { port: 7123, authToken: OP_TOKEN, workspace } as LAXConfig;
  ctx = {
    config, appRegistry: { get: () => undefined },
    broadcastAll: (frame: unknown) => broadcastAll(frame),
    sessionStore: { load: (id: string) => stored[id] ?? null },
  } as unknown as ServerContext;
  agentServer = await startAgentOrigin({ config, publicDir, getCtx: () => ctx, appPortsFile: join(root, "app-origin-ports.json") });
});

afterAll(async () => {
  agentServer.closeAllConnections();
  await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "app-chat-data-"));
  process.env.LAX_DATA_DIR = dataDir;
  broadcastAll = vi.fn<(frame: unknown) => void>();
  stored = {};
  turns.calls = [];
  turns.script = async ({ sseSink }) => { sseSink({ type: "stream", delta: "Hello" }); };
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const cap = (appId: string) => deriveAppChatCapability(OP_TOKEN, appId);
const originOf = async (appId: string) => (await ensureAppOrigin(appId))!;

/** A call as the app's own page makes it: from its origin, with its capability. */
async function page(appId: string, path: string, init: { method?: string; body?: unknown; token?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
  const origin = await originOf(appId);
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const sentOrigin = init.origin === undefined ? origin : init.origin;
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${init.token ?? cap(appId)}`,
      ...(method === "POST" && sentOrigin ? { Origin: sentOrigin } : {}),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const send = (appId: string, thread: string, body: unknown, init: Parameters<typeof page>[2] = {}) =>
  page(appId, `/api/app-chat/${appId}/threads/${thread}/messages`, { ...init, body });

async function events(res: Response): Promise<Array<Record<string, unknown>>> {
  return (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

function uiCall(handler: typeof handleInboxRoutes, method: string, path: string, role: Role, body?: unknown) {
  let status = 0;
  let text = "";
  const res = { writeHead: (s: number) => { status = s; }, setHeader: () => {}, end: (b: string) => { text = b; } } as unknown as ServerResponse;
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { headers: { "content-type": "application/json" }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } } as unknown as IncomingMessage;
  return handler(method, new URL(`http://localhost${path}`), req, res, ctx, role).then((handled) => ({ handled, status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }));
}

const requestItem = () => inboxStore().list().find((item) => item.appChatRequest?.appId === "hub");

describe("who may call an app's chat", () => {
  it("only that app's capability, on that app's own listener", async () => {
    recordAppChatAnswer("hub", "granted");
    const path = "/api/app-chat/hub/threads/main/messages";
    const hub = await originOf("hub");
    const post = (base: string, token: string, origin = hub) =>
      fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });

    for (const token of ["", OP_TOKEN, cap("other"), deriveConnectorCapability(OP_TOKEN), deriveAppDataCapability(OP_TOKEN, "hub")]) {
      expect((await post(hub, token)).status, token.slice(0, 12)).toBe(401);
    }
    // The right capability on another listener: the shared one, another app's.
    expect((await post(agentOrigin(), cap("hub"))).status).toBe(401);
    expect((await post(await originOf("other"), cap("hub"), await originOf("other"))).status).toBe(401);
    // Another app's own capability does not open this app's threads on its own listener either.
    expect((await page("other", path, { body: { message: "hi" } })).status).toBe(401);
    expect(turns.calls).toHaveLength(0);
    expect((await post(hub, cap("hub"))).status).toBe(200);
  });

  it("only from the app's own page", async () => {
    recordAppChatAnswer("hub", "granted");
    const other = await originOf("other");
    for (const origin of [null, other, "http://127.0.0.1:7123", "https://evil.example", "null"]) {
      const res = await send("hub", "main", { message: "hi" }, { origin });
      expect(res.status, String(origin)).toBe(403);
      expect((await res.json() as { code: string }).code).toBe("wrong_origin");
    }
    expect((await send("hub", "main", { message: "hi" }, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await send("hub", "main", { message: "hi" }, { headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
  });

  it("is injected into that app's page as window.lax.chat, with its own capability and no other app's", async () => {
    const html = await (await fetch(`${await originOf("hub")}/apps/hub/`)).text();
    expect(html).toContain("<script data-lax-app-chat>");
    expect(html).toContain(`__laxInstallAppChat("hub",${JSON.stringify(cap("hub"))});`);
    expect(html).not.toContain(cap("other"));
    expect(html).not.toContain(OP_TOKEN);
    // A phone over the broker cannot use it, so it is not handed it.
    const tunneled = await (await fetch(`${await originOf("hub")}/apps/hub/`, { headers: { "x-lax-tunnel": "1" } })).text();
    expect(tunneled).not.toContain("data-lax-app-chat");
    expect(tunneled).not.toContain(cap("hub"));
  });
});

describe("the user's yes, once per app", () => {
  it("refuses until answered and asks once, by the app's id, saying what it opens", async () => {
    const first = await send("hub", "main", { message: "hi" });
    expect(first.status).toBe(403);
    expect((await first.json() as { code: string }).code).toBe("needs_approval");
    await send("hub", "main", { message: "again" });
    await page("hub", "/api/app-chat/hub/threads/main/messages");
    const asked = inboxStore().list().filter((item) => item.kind === "approval");
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toBe('The app "hub" wants to talk to your agents');
    expect(asked[0].needsYou).toBe(true);
    expect(asked[0].body).toContain("full powers");
    expect(asked[0].body).toContain("while you are away");
    expect(asked[0].actions?.map((a) => a.id)).toEqual(["approve", "decline"]);
    // What the page sent never words the request.
    expect(JSON.stringify(asked[0])).not.toContain("again");
    expect(turns.calls).toHaveLength(0);
    // The app the answer is for never leaves the server.
    expect(JSON.stringify(listInbox())).not.toContain("appChatRequest");
  });

  it("Approve lets the app through from then on, and tells every tab", async () => {
    await send("hub", "main", { message: "hi" });
    const item = requestItem()!;
    const answered = await uiCall(handleInboxRoutes, "POST", "/api/inbox/act", "user", { id: item.id, action: "approve" });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ ok: true, resolution: "approved" });
    expect(appChatAnswer("hub")).toBe("granted");
    expect(appChatAnswer("other")).toBeUndefined();
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { appChatGrants: true } });
    expect(broadcastAll).toHaveBeenCalledWith(expect.objectContaining({ type: "inbox_changed", action: "approve", id: item.id }));

    const res = await send("hub", "main", { message: "hi", persona: "You plan shifts." });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await events(res)).toEqual([{ type: "delta", text: "Hello" }, { type: "done" }]);
    expect(turns.calls[0]).toMatchObject({ sessionId: appChatSessionId("hub", "main"), message: "hi", requestRole: "operator" });
    // A second answer to the same card changes nothing.
    expect((await uiCall(handleInboxRoutes, "POST", "/api/inbox/act", "user", { id: item.id, action: "decline" })).status).toBe(409);
    expect(appChatAnswer("hub")).toBe("granted");
  });

  it("Decline blocks the app without asking again", async () => {
    await send("hub", "main", { message: "hi" });
    await uiCall(handleInboxRoutes, "POST", "/api/inbox/act", "user", { id: requestItem()!.id, action: "decline" });
    expect(appChatAnswer("hub")).toBe("denied");
    const res = await send("hub", "main", { message: "hi" });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe("denied");
    expect(inboxStore().list().filter((item) => item.kind === "approval" && item.resolvedAt === undefined)).toHaveLength(0);
    expect(turns.calls).toHaveLength(0);
  });

  it("is never the agent's to give", async () => {
    await send("hub", "main", { message: "hi" });
    const refused = await uiCall(handleInboxRoutes, "POST", "/api/inbox/act", "agent", { id: requestItem()!.id, action: "approve" });
    expect(refused.status).toBe(403);
    expect(appChatAnswer("hub")).toBeUndefined();
  });
});

describe("the Apps page's grants", () => {
  it("lists the answers and takes one back, for the operator only", async () => {
    recordAppChatAnswer("hub", "granted", 1_000);
    recordAppChatAnswer("other", "denied", 2_000);
    for (const role of ["agent", "user", "readonly"] as Role[]) {
      expect((await uiCall(handleAppChatGrantRoutes, "GET", "/api/app-chat-grants", role)).status, role).toBe(403);
      expect((await uiCall(handleAppChatGrantRoutes, "POST", "/api/app-chat-grants/hub/forget", role)).status, role).toBe(403);
    }
    expect(listAppChatGrants()).toHaveLength(2);
    const listed = await uiCall(handleAppChatGrantRoutes, "GET", "/api/app-chat-grants", "operator");
    expect(listed.body).toEqual({ grants: [{ appId: "hub", answer: "granted", at: 1_000 }, { appId: "other", answer: "denied", at: 2_000 }] });

    const forgot = await uiCall(handleAppChatGrantRoutes, "POST", "/api/app-chat-grants/hub/forget", "operator");
    expect(forgot.body).toEqual({ ok: true, forgotten: true });
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { appChatGrants: true } });
    expect(appChatAnswer("hub")).toBeUndefined();
    // The app is asked about afresh.
    expect((await (await send("hub", "main", { message: "hi" })).json() as { code: string }).code).toBe("needs_approval");
    expect((await uiCall(handleAppChatGrantRoutes, "POST", "/api/app-chat-grants/hub/forget", "operator")).body).toEqual({ ok: true, forgotten: false });
    expect((await uiCall(handleAppChatGrantRoutes, "GET", "/api/apps", "operator")).handled).toBe(false);
  });
});

describe("an allowed app's threads", () => {
  beforeEach(() => recordAppChatAnswer("hub", "granted"));

  it("refuses a slash command, a bad body and a bad thread name without starting a turn", async () => {
    const code = async (res: Response) => `${res.status} ${(await res.json() as { code: string }).code}`;
    expect(await code(await send("hub", "main", { message: "/approve it" }))).toBe("400 slash_command");
    expect(await code(await send("hub", "main", { message: "" }))).toBe("400 bad_request");
    expect(await code(await send("hub", "Bad.Name", { message: "hi" }))).toBe("400 bad_thread");
    expect(turns.calls).toHaveLength(0);
  });

  it("refuses a second message while the thread is answering, and takes one after", async () => {
    let finish: () => void = () => {};
    turns.script = ({ sseSink }) => new Promise<void>((resolve) => { sseSink({ type: "stream", delta: "…" }); finish = resolve; });
    const first = send("hub", "busy", { message: "one" });
    await vi.waitFor(() => expect(turns.calls).toHaveLength(1));
    const second = await send("hub", "busy", { message: "two" });
    expect(second.status).toBe(409);
    expect((await second.json() as { code: string }).code).toBe("busy");
    finish();
    expect(await events(await first)).toEqual([{ type: "delta", text: "…" }, { type: "done" }]);
    turns.script = async () => {};
    expect((await send("hub", "busy", { message: "three" })).status).toBe(200);
  });

  it("reads a thread's history as plain turns, and only its own", async () => {
    stored[appChatSessionId("hub", "main")] = {
      id: appChatSessionId("hub", "main"), title: "hub: main", createdAt: 1, updatedAt: 2,
      messages: [{ role: "user", content: "Who is on?" }, { role: "assistant", content: "Ana and Raj." }],
    };
    stored["users-own-chat"] = { id: "users-own-chat", title: "private", createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: "my secret" }] };
    const res = await page("hub", "/api/app-chat/hub/threads/main/messages");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [{ role: "user", text: "Who is on?" }, { role: "assistant", text: "Ana and Raj." }] });
    expect(await (await page("hub", "/api/app-chat/hub/threads/empty/messages")).json()).toEqual({ messages: [] });
  });

  it("stops a thread, and answers nothing else under the prefix", async () => {
    const stop = await page("hub", "/api/app-chat/hub/threads/main/stop", { method: "POST" });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ stopped: false });
    expect((await page("hub", "/api/app-chat/hub/threads/main/stop")).status).toBe(401);
    expect((await page("hub", "/api/app-chat/hub/threads/main/other", { method: "POST" })).status).toBe(401);
    expect((await page("hub", "/api/app-chat/hub/grants")).status).toBe(401);
  });
});
