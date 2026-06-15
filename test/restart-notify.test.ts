import { describe, it, expect } from "vitest";
import { buildRestartPingMessage, resolveNotifyTarget, type RestartNotice } from "../src/restart-notify.js";
import { restart } from "../src/tools/restart-tool.js";

const base: RestartNotice = { channel: "telegram", target: "123", reason: "pick up new code", requestedAt: 1000, deadlineMs: 1000 + 120_000 };

describe("buildRestartPingMessage", () => {
  it("reports a clean back-up within the deadline", () => {
    const msg = buildRestartPingMessage(base, base.requestedAt + 15_000);
    expect(msg).toMatch(/back up/i);
    expect(msg).toContain("pick up new code");
    expect(msg).not.toMatch(/longer than expected/i);
  });

  it("warns when the boot is past the deadline (slow / recovered after a failure)", () => {
    const msg = buildRestartPingMessage(base, base.deadlineMs + 30_000);
    expect(msg).toMatch(/longer than expected/i);
  });
});

describe("resolveNotifyTarget — channel from session id", () => {
  it("routes a Telegram session back to its chat", async () => {
    expect(await resolveNotifyTarget({ _sessionId: "tg-8199987986" })).toEqual({ channel: "telegram", target: "8199987986" });
  });

  it("routes a WhatsApp session back to its phone", async () => {
    expect(await resolveNotifyTarget({ _sessionId: "wa-15551234567" })).toEqual({ channel: "whatsapp", target: "15551234567" });
  });

  it("returns null for a web session when no bridge is connected", async () => {
    // No bridges connected in the test process → nothing to ping back on.
    expect(await resolveNotifyTarget({ _sessionId: "chat-web-abc" })).toBeNull();
  });
});

describe("restart tool — desktop guard", () => {
  it("refuses cleanly when not running under the desktop app", async () => {
    // LAX_DESKTOP_BRIDGE is unset in tests → desktopBridgeAvailable() is false.
    const r = await restart.execute({ reason: "test" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/desktop app|manually/i);
  });
});
