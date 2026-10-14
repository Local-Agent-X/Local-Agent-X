// restart and apply_update ping the user back over a messaging bridge, so
// they refuse without one. The descriptions say so, and the refusal names the
// condition rather than a generic "no channel".
import { describe, expect, it, vi } from "vitest";

vi.mock("../desktop-bridge.js", () => ({
  desktopBridgeAvailable: () => true,
  desktopRestartServer: vi.fn(),
  desktopRelaunchApp: vi.fn(),
}));
vi.mock("../restart-notify.js", () => ({
  writeRestartNotice: vi.fn(),
  resolveNotifyTarget: async () => null,
}));
vi.mock("../update-service.js", () => ({
  checkForUpdate: vi.fn(),
  applyUpdateNow: vi.fn(),
}));

const { restart } = await import("./restart-tool.js");
const { applyUpdate } = await import("./update-tools.js");

describe("restart / apply_update without a messaging channel", () => {
  it("both describe the Telegram-or-WhatsApp requirement", () => {
    expect(restart.description).toMatch(/connected Telegram or WhatsApp channel.*refused otherwise/);
    expect(applyUpdate.description).toMatch(/connected Telegram or WhatsApp channel.*refused otherwise/);
  });

  it("restart refuses and names the missing channel", async () => {
    const r = await restart.execute({ reason: "pick up new code" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Refused: restart needs a connected Telegram or WhatsApp channel/);
  });

  it("apply_update refuses and names the missing channel", async () => {
    const r = await applyUpdate.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Refused: apply_update needs a connected Telegram or WhatsApp channel/);
  });
});
