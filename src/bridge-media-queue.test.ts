import { describe, it, expect } from "vitest";
import { enqueueBridgeMedia, drainBridgeMedia } from "./bridge-media-queue.js";

describe("bridge-media-queue", () => {
  it("drains the exact media enqueued for an op, decoding image b64 to buffers", () => {
    const b64 = Buffer.from("hello").toString("base64");
    enqueueBridgeMedia("op-1", { imageB64: [b64], imagePath: "/u/a.jpg", videoPath: "/v/b.mp4" });
    const out = drainBridgeMedia("op-1");
    expect(out).not.toBeNull();
    expect(out!.images.map(b => b.toString())).toEqual(["hello"]);
    expect(out!.imagePaths).toEqual(["/u/a.jpg"]);
    expect(out!.videoPaths).toEqual(["/v/b.mp4"]);
  });

  it("accumulates multiple enqueues for the same op (one tool call per enqueue)", () => {
    enqueueBridgeMedia("op-2", { imagePath: "/u/1.jpg" });
    enqueueBridgeMedia("op-2", { videoPath: "/v/2.mp4" });
    const out = drainBridgeMedia("op-2");
    expect(out!.imagePaths).toEqual(["/u/1.jpg"]);
    expect(out!.videoPaths).toEqual(["/v/2.mp4"]);
  });

  it("drains once — a second drain returns null (no double-send)", () => {
    enqueueBridgeMedia("op-3", { imagePath: "/u/x.jpg" });
    expect(drainBridgeMedia("op-3")).not.toBeNull();
    expect(drainBridgeMedia("op-3")).toBeNull();
  });

  it("returns null for an op that never enqueued (turn with no media)", () => {
    expect(drainBridgeMedia("op-never")).toBeNull();
  });

  it("ignores an empty op id", () => {
    enqueueBridgeMedia("", { imagePath: "/u/x.jpg" });
    expect(drainBridgeMedia("")).toBeNull();
  });

  it("bounds memory: web-chat ops that never drain get evicted (oldest first)", () => {
    enqueueBridgeMedia("op-old", { imagePath: "/u/old.jpg" });
    for (let i = 0; i < 64; i++) enqueueBridgeMedia(`op-fill-${i}`, { imagePath: `/u/${i}.jpg` });
    expect(drainBridgeMedia("op-old")).toBeNull(); // evicted past the cap
    expect(drainBridgeMedia("op-fill-63")).not.toBeNull(); // newest survives
  });
});
