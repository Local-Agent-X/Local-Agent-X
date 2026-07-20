import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-bridge-media-"));
process.env.LAX_DATA_DIR = dataDir;

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable bridge media queue", () => {
  it("survives module restart after response publication", async () => {
    const first = await import("./bridge-media-queue.js");
    first.enqueueBridgeMedia("op-media-restart", { imageB64: [Buffer.from("one").toString("base64")] });
    first.persistBridgeMedia("op-media-restart");
    vi.resetModules();
    const restarted = await import("./bridge-media-queue.js");
    expect(restarted.readBridgeMedia("op-media-restart")?.images[0].toString()).toBe("one");
  });
});
