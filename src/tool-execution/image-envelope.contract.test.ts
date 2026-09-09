import { describe, it, expect } from "vitest";
import type { ToolCallContext } from "./context.js";
import type { ToolResult } from "../types.js";
import { shapeMsg } from "./audit-tool-call.js";

// CONTRACT for the vision envelope. shapeMsg is the ONE place a tool's image
// bytes become something the model can see, and the chat dispatcher harvests
// those bytes back off the user-role message it produces (chat-tool-dispatcher
// harvestedImages) to feed the bridge. A tool that emits images through a shape
// shapeMsg doesn't handle is silently blind AND silently undelivered — so both
// shapes are locked here.

const PX = "iVBORw0KGgo=";

function ctxWith(result: ToolResult, name = "read_video_frames"): ToolCallContext {
  return {
    tc: { id: "call-1", name, arguments: "{}" },
    result,
    msgs: [],
  } as unknown as ToolCallContext;
}

function imageParts(msg: unknown): Array<{ type: string; image_url?: { url: string } }> {
  const content = (msg as { content: unknown }).content;
  return Array.isArray(content) ? content as Array<{ type: string; image_url?: { url: string } }> : [];
}

describe("_image — the single-image shape", () => {
  it("pushes a tool message plus one user-vision message", () => {
    const ctx = ctxWith({ content: "ignored", _image: { mime: "image/png", b64: PX, path: "/a.png", question: "what?" } }, "view_image");
    shapeMsg(ctx);
    expect(ctx.msgs).toHaveLength(2);
    expect(ctx.msgs[0].role).toBe("tool");
    expect(ctx.msgs[0].content).toBe("Image loaded: /a.png\nQuestion: what?");
    const parts = imageParts(ctx.msgs[1]);
    expect(parts.filter(p => p.type === "image_url")).toHaveLength(1);
  });
});

describe("_images — the multi-image shape", () => {
  const frames = [0.5, 1.5, 2.5].map(t => ({
    mime: "image/jpeg", b64: PX, path: `/clip.mp4@${t}s`, question: "what happens?",
  }));

  it("feeds every frame to the model in ONE user message, in order", () => {
    const ctx = ctxWith({ content: "3 frame(s) sampled at 0.5s, 1.5s, 2.5s", _images: frames });
    shapeMsg(ctx);
    expect(ctx.msgs).toHaveLength(2);
    const parts = imageParts(ctx.msgs[1]);
    expect(parts.filter(p => p.type === "image_url")).toHaveLength(3);
    expect(parts[0].type).toBe("text");
  });

  it("keeps the tool text — the timestamps saying which second each frame is from", () => {
    const ctx = ctxWith({ content: "3 frame(s) sampled at 0.5s, 1.5s, 2.5s", _images: frames });
    shapeMsg(ctx);
    // The single-image branch REPLACES the tool text with "Image loaded: …".
    // Doing that here would strip the only mapping from frame to timestamp.
    expect(String(ctx.msgs[0].content)).toContain("0.5s, 1.5s, 2.5s");
  });

  it("emits data: URLs the dispatcher's harvester can parse back out", () => {
    const ctx = ctxWith({ content: "frames", _images: frames });
    shapeMsg(ctx);
    for (const part of imageParts(ctx.msgs[1]).filter(p => p.type === "image_url")) {
      // Same regex chat-tool-dispatcher uses to recover the bytes for the bridge.
      expect(/^data:([^;]+);base64,(.+)$/.exec(part.image_url!.url)).toBeTruthy();
    }
  });

  it("an empty _images array produces no vision message at all", () => {
    const ctx = ctxWith({ content: "nothing", _images: [] });
    shapeMsg(ctx);
    expect(ctx.msgs).toHaveLength(1);
  });

  it("_image wins when a tool sets both, and no frames are double-fed", () => {
    const ctx = ctxWith({
      content: "both",
      _image: { mime: "image/png", b64: PX, path: "/a.png", question: "single" },
      _images: frames,
    });
    shapeMsg(ctx);
    expect(ctx.msgs).toHaveLength(2);
    expect(imageParts(ctx.msgs[1]).filter(p => p.type === "image_url")).toHaveLength(1);
  });
});
