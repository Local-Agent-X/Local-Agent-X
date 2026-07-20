import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-durable-command-"));
process.env.LAX_DATA_DIR = dataDir;
const { runDurableInboundCommand } = await import("./durable-inbound-command.js");

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable inbound control commands", () => {
  it.each(["telegram", "whatsapp"] as const)("executes a %s mutation once and replays its unsent response", async (channel) => {
    const execute = vi.fn(() => "done");
    const request = {
      from: "42", name: "Peter", text: "/reset", sessionId: `${channel}-42`,
      deliveryId: `${channel}:control`, deliveryFingerprint: "stable-control",
    };
    const plan = { kind: "reset", sessionKey: request.sessionId };
    const first = await runDurableInboundCommand(channel, request, plan, execute);
    await first?.acknowledgeDelivery?.(false);
    const replay = await runDurableInboundCommand(channel, request, plan, execute);
    expect(replay).toMatchObject({ text: "done", speakable: "done" });
    expect(execute).toHaveBeenCalledTimes(1);
    await replay?.acknowledgeDelivery?.(true);
    await expect(runDurableInboundCommand(channel, request, plan, execute)).resolves.toBeNull();
  });

  it("reuses the write-ahead plan after apply crashes before response publication", async () => {
    const request = {
      from: "42", name: "Peter", text: "/stop", sessionId: "tg-42",
      deliveryId: "telegram:planned-crash", deliveryFingerprint: "planned-crash",
    };
    const plan = { kind: "stop", targetOpIds: ["op-1"], actor: "telegram-stop" };
    const applied = new Set<string>();
    const execute = vi.fn(async (durablePlan: { [key: string]: string | string[] | boolean | null }) => {
      applied.add((durablePlan.targetOpIds as string[])[0]);
      if (execute.mock.calls.length === 1) throw new Error("crash after apply");
      return "Stopped.";
    });
    await expect(runDurableInboundCommand("telegram", request, plan, execute)).rejects.toThrow("crash after apply");
    await expect(runDurableInboundCommand("telegram", request, { ...plan, targetOpIds: ["wrong"] }, execute))
      .resolves.toMatchObject({ text: "Stopped." });
    expect(execute.mock.calls[1][0]).toEqual(plan);
    expect(applied.size).toBe(1);
  });
});
