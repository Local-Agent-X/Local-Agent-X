// send_video enforces the channel's own cap (the bridge refuses a WhatsApp
// video over 16MB; bridge-media-forward.ts), read off the trusted session
// stamp — the description used to promise 16MB while the tool let 50MB through.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMessagingSessionId } from "../session/channel-registry.js";
import { sendVideoTool } from "./media-send-tools.js";

const dir = mkdtempSync(join(tmpdir(), "lax-send-video-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A file whose stat size is `mb` without writing the bytes. */
function video(name: string, mb: number): string {
  const p = join(dir, name);
  writeFileSync(p, "");
  truncateSync(p, mb * 1048576);
  return p;
}

describe("send_video per-channel size cap", () => {
  it("refuses a 20MB video on WhatsApp (16MB) and names the channel", async () => {
    const r = await sendVideoTool.execute({ path: video("wa.mp4", 20), _sessionId: buildMessagingSessionId("whatsapp", "15550001111") });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/over the 16MB whatsapp limit/);
  });

  it("sends the same 20MB video on Telegram (50MB)", async () => {
    const r = await sendVideoTool.execute({ path: video("tg.mp4", 20), _sessionId: buildMessagingSessionId("telegram", "424242") });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Sending video/);
  });

  it("refuses over 50MB on any channel", async () => {
    const r = await sendVideoTool.execute({ path: video("big.mp4", 51) });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/over the 50MB messaging limit/);
  });
});
