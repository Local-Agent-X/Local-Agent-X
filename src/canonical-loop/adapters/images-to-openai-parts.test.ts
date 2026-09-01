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

  it("empty text AND zero images → historical single empty-text part, never an empty array", () => {
    // Contract lock: the degenerate fallback is reserved for the one case
    // where nothing was attached at all — callers only reach this helper
    // when images exist, and an empty content array is rejected by every
    // provider. Any requested image that cannot be sent yields a non-empty
    // failure note instead (see the unreadable-attachments block below).
    expect(imagesToOpenAIParts("", [])).toEqual([{ type: "text", text: "" }]);
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

describe("imagesToOpenAIParts — unreadable attachments are reported, not dropped", () => {
  let dir = "";
  let readable = "";
  let missing = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-img-parts-unreadable-"));
    readable = join(dir, "logo.png");
    writeFileSync(readable, Buffer.from("hello"));
    missing = join(dir, "pruned.png"); // never written — readFileSync throws ENOENT
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("caption-less send, single unreadable file → exactly one non-empty failure note, no image part", () => {
    // Regression: the read failure was swallowed, parts came back empty,
    // the degenerate fallback emitted {text:""}, and the wire-site
    // sanitizer told the model the user sent "[empty message]".
    const parts = imagesToOpenAIParts("", [{ url: "", name: "pruned.png", filePath: missing }]);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    const note = textParts(parts)[0];
    expect(note.trim().length).toBeGreaterThan(0);
    expect(note).toContain("pruned.png");
    expect(note).toContain("could not be read");
    expect(note).toContain("ENOENT");
    expect(note).not.toContain(dir); // no absolute path in the note
    expect(imageParts(parts)).toEqual([]);
  });

  it("caption + one readable + one unreadable → [text, image, failure-note, hint], every text non-empty", () => {
    const parts = imagesToOpenAIParts("use the logo", [
      { url: "", name: "logo.png", filePath: readable },
      { url: "", name: "pruned.png", filePath: missing },
    ]);
    expect(parts.map(p => p.type)).toEqual(["text", "image_url", "text", "text"]);
    const texts = textParts(parts);
    expect(texts[0]).toBe("use the logo");
    expect(texts[1]).toContain("pruned.png");
    expect(texts[1]).toContain("could not be read");
    // The path hint lists only the file that was actually sent.
    expect(texts[2]).toContain(readable);
    expect(texts[2]).not.toContain(missing);
    for (const t of texts) expect(t.trim().length).toBeGreaterThan(0);
  });

  it("name-less ref → note falls back to the path basename, still no absolute path", () => {
    const parts = imagesToOpenAIParts("", [{ url: "", name: "", filePath: missing }]);
    const note = textParts(parts)[0];
    expect(note).toContain("pruned.png");
    expect(note).not.toContain(dir);
  });

  it("ref with neither inline bytes nor a file path → failure note, not the empty-text fallback", () => {
    // Previously locked as [{text:""}]; that shape reaches the model as
    // "[empty message]" even though the user attached something.
    const parts = imagesToOpenAIParts("", [{ url: "", name: "ghost.png" }]);
    expect(parts).toHaveLength(1);
    expect(imageParts(parts)).toEqual([]);
    expect(textParts(parts)[0]).toContain("ghost.png");
    expect(textParts(parts)[0]).toContain("could not be read");
  });
});
