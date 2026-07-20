import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessage } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Telegram multipart delivery progress", () => {
  it("skips accepted chunks and checkpoints each newly accepted chunk", async () => {
    const completed = new Set(["text:0"]);
    const acknowledge = vi.fn(async (part: string) => { completed.add(part); });
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMessage("token", "42", `${"a".repeat(4000)}b`, {
      prefix: "text", isComplete: part => completed.has(part), acknowledge,
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith("text:1");
  });
});
