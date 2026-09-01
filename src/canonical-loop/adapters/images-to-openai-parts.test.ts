import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imagesToOpenAIParts, type OpenAIVisionPart } from "./images-to-openai-parts.js";

const DATA_URL = "data:image/png;base64,aGVsbG8=";
const INLINE_IMG = { url: DATA_URL, name: "shot.png" };

function textParts(parts: OpenAIVisionPart[]): string[] {
  return parts.flatMap(p => (p.type === "text" ? [p.text] : []));
}

function imageParts(parts: OpenAIVisionPart[]): string[] {
  return parts.flatMap(p => (p.type === "image_url" ? [p.image_url.url] : []));
}

describe("imagesToOpenAIParts — leading text part", () => {
  it("text + image → text part first, then the image part", () => {
    const parts = imagesToOpenAIParts("what is this?", [INLINE_IMG]);
    expect(parts).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: DATA_URL, detail: "auto" } },
    ]);
  });

  it("empty text + image → image part only, no empty text part", () => {
    // Regression: a persisted image-only user row ({content:"", images})
    // used to become [{text:""}, {image}] and Anthropic rejected the whole
    // request with 400 "text content blocks must be non-empty".
    const parts = imagesToOpenAIParts("", [INLINE_IMG]);
    expect(imageParts(parts)).toEqual([DATA_URL]);
    expect(textParts(parts)).toEqual([]);
  });

  it("whitespace-only text + image → image part only", () => {
    const parts = imagesToOpenAIParts(" \n\t ", [INLINE_IMG]);
    expect(imageParts(parts)).toEqual([DATA_URL]);
    expect(textParts(parts)).toEqual([]);
  });

  it("non-empty text is forwarded verbatim — surrounding whitespace is not trimmed", () => {
    const parts = imagesToOpenAIParts("  keep me  ", [INLINE_IMG]);
    expect(textParts(parts)).toEqual(["  keep me  "]);
  });

  it("non-empty text, no images → single text part (unchanged behavior)", () => {
    expect(imagesToOpenAIParts("hello", [])).toEqual([{ type: "text", text: "hello" }]);
  });

  it("empty text AND no usable image → historical single empty-text part, never an empty array", () => {
    // Contract lock: this degenerate case is deliberately left as-is —
    // callers only reach this helper when images exist, but an image with
    // neither a data URL nor a file path is skipped, and an empty content
    // array is rejected by every provider.
    expect(imagesToOpenAIParts("", [])).toEqual([{ type: "text", text: "" }]);
    expect(imagesToOpenAIParts("", [{ url: "", name: "ghost.png" }])).toEqual([{ type: "text", text: "" }]);
  });

  it("several images with no text → one image part each, no text part", () => {
    const parts = imagesToOpenAIParts("", [INLINE_IMG, { url: "data:image/jpeg;base64,Yg==", name: "b.jpg" }]);
    expect(imageParts(parts)).toEqual([DATA_URL, "data:image/jpeg;base64,Yg=="]);
    expect(textParts(parts)).toEqual([]);
  });
});

describe("imagesToOpenAIParts — on-disk attachments (the real upload shape)", () => {
  let dir = "";
  let filePath = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-img-parts-"));
    filePath = join(dir, "upload.png");
    writeFileSync(filePath, Buffer.from("hello"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("image-only row with a file attachment → no empty leading text; hint text still trails the image", () => {
    const parts = imagesToOpenAIParts("", [{ url: "", name: "upload.png", filePath }]);
    expect(parts[0].type).toBe("image_url");
    expect(imageParts(parts)).toEqual([`data:image/png;base64,${Buffer.from("hello").toString("base64")}`]);
    // The trailing path hint is the only text part, and it carries the path.
    const texts = textParts(parts);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(filePath);
    // The invariant Anthropic enforces: every text block is non-empty.
    for (const t of texts) expect(t.trim().length).toBeGreaterThan(0);
  });

  it("text + file attachment → user text first, image, then the path hint", () => {
    const parts = imagesToOpenAIParts("use this logo", [{ url: "", name: "upload.png", filePath }]);
    expect(parts.map(p => p.type)).toEqual(["text", "image_url", "text"]);
    expect(textParts(parts)[0]).toBe("use this logo");
    expect(textParts(parts)[1]).toContain(filePath);
  });
});
