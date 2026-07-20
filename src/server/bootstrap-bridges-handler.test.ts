import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-bridge-handler-"));
process.env.LAX_DATA_DIR = dataDir;
const { applyBridgeInjection, resolveLiveBridgeOps } = vi.hoisted(() => ({
  applyBridgeInjection: vi.fn().mockResolvedValue(true),
  resolveLiveBridgeOps: vi.fn().mockResolvedValue(["op-running"]),
}));
vi.mock("../bridge-control.js", () => ({ applyBridgeInjection, resolveLiveBridgeOps, cancelBridgeOps: vi.fn() }));
const { createBridgeHandler } = await import("./bootstrap-bridges.js");

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("bridge command recovery", () => {
  it("replays persisted steering after the transport no longer reports a busy turn", async () => {
    const handler = createBridgeHandler({
      sessions: new Map(), sessionStore: { delete: vi.fn() } as never,
      config: {} as never, getContext: vi.fn(() => { throw new Error("ordinary chat path must not run"); }),
    });
    const payload = {
      from: "42", name: "Peter", text: "make it blue", sessionId: "tg-42",
      deliveryId: "update:steer-replay", deliveryFingerprint: "stable", deliveryTarget: "42",
    };
    const first = await handler("telegram", { ...payload, intent: "steer" });
    if (!first || typeof first === "string") throw new Error("durable reply expected");
    await first.acknowledgeDelivery?.(false);

    const replay = await handler("telegram", payload);

    expect(replay).toMatchObject({ text: "→ Got it — passing that to the running task." });
    expect(resolveLiveBridgeOps).toHaveBeenCalledTimes(1);
    expect(applyBridgeInjection).toHaveBeenCalledTimes(1);
  });
});
