/**
 * POST /api/telegram/owner must validate before it mutates.
 *
 * setAllowedChatIds persists immediately, so an early version that called it
 * and *then* returned 400 on an unusable list silently cleared a working
 * owner whenever the operator fat-fingered the chat ID — leaving the bot
 * unowned and every inbound message rejected.
 */

import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { handleTelegramRoutes } from "./telegram.js";

function harness(initial: string[]) {
  let owner = [...initial];
  const setAllowedChatIds = vi.fn((ids: string[]) => {
    owner = ids.filter(id => /^-?[1-9]\d{0,18}$/.test(String(id).trim()));
    return [...owner];
  });
  const ctx = {
    telegramBridge: { setAllowedChatIds, getStatus: () => ({ allowedChatIds: [...owner] }) },
    secretsStore: { has: () => false },
  } as any;
  return { ctx, setAllowedChatIds, currentOwner: () => owner };
}

async function postOwner(ctx: any, body: unknown) {
  const req: any = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: {}, socket: { remoteAddress: "127.0.0.1" },
  });
  let status = 0; let payload: any;
  const res: any = {
    statusCode: 200, setHeader: () => {}, writeHead: (s: number) => { status = s; },
    end: (b: string) => { payload = b ? JSON.parse(b) : undefined; },
  };
  await handleTelegramRoutes("POST", new URL("http://x/api/telegram/owner"), req, res, ctx, "operator");
  return { status: status || res.statusCode, payload };
}

describe("POST /api/telegram/owner", () => {
  it("rejects an unusable chat ID without touching the existing owner", async () => {
    const { ctx, setAllowedChatIds, currentOwner } = harness(["42"]);

    const { status, payload } = await postOwner(ctx, { chatIds: ["not-an-id"] });

    expect(status).toBe(400);
    expect(payload.error).toMatch(/whole number/);
    expect(setAllowedChatIds).not.toHaveBeenCalled();
    expect(currentOwner()).toEqual(["42"]);
  });

  it("sets a valid owner", async () => {
    const { ctx, currentOwner } = harness([]);
    const { status, payload } = await postOwner(ctx, { chatIds: ["123456789"] });
    expect(status).toBe(200);
    expect(payload.chatIds).toEqual(["123456789"]);
    expect(currentOwner()).toEqual(["123456789"]);
  });

  it("allows an explicit clear", async () => {
    const { ctx, currentOwner } = harness(["42"]);
    const { status } = await postOwner(ctx, { chatIds: [] });
    expect(status).toBe(200);
    expect(currentOwner()).toEqual([]);
  });
});
