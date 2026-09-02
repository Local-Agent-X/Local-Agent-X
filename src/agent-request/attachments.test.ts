import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { processAttachments, unreadableAttachmentNote } from "./attachments.js";

// Locks the prepare-request END of the attachment seam: the rule "a non-image
// upload must hand the model a readable /uploads PATH" used to be inline and
// silently regressed (non-images were dropped, 404'ing every PDF/doc).
describe("processAttachments", () => {
  let up: string;
  beforeAll(() => { up = mkdtempSync(join(tmpdir(), "att-unit-")); });
  afterAll(() => rmSync(up, { recursive: true, force: true }));

  it("routes a non-image upload to a PATH note (model must not be left with only the display name)", () => {
    writeFileSync(join(up, "abc123.pdf"), "pdf-bytes");
    const r = processAttachments([{ isImage: false, name: "Invoice.pdf", url: "/uploads/abc123.pdf", dataUrl: null }], up);
    expect(r.fileAttachments).toEqual([{ name: "Invoice.pdf", ref: "/uploads/abc123.pdf" }]);
    expect(r.images).toEqual([]);
    expect(r.fileAttachmentNote).toContain("/uploads/abc123.pdf");
    expect(r.fileAttachmentNote).toContain("Invoice.pdf");
    expect(r.fileAttachmentNote).toContain("Pass the PATH");
  });

  it("routes an image to images[] with NO file note", () => {
    const r = processAttachments([{ isImage: true, name: "pic.png", url: "/uploads/z.png", dataUrl: null }], up);
    expect(r.images).toEqual([{ name: "pic.png", url: "/uploads/z.png", filePath: join(up, "z.png") }]);
    expect(r.fileAttachments).toEqual([]);
    expect(r.fileAttachmentNote).toBe("");
  });

  it("decodes a base64 dataUrl (the mobile path) to a file in the uploads dir and refs it", () => {
    const payload = Buffer.from("pretend-pdf-bytes").toString("base64");
    const r = processAttachments([{ isImage: false, name: "m.pdf", url: null, dataUrl: `data:application/pdf;base64,${payload}` }], up);
    expect(r.fileAttachments).toHaveLength(1);
    const ref = r.fileAttachments[0].ref;
    expect(ref).toMatch(/^\/uploads\/att-[0-9a-f]{12}\.pdf$/);
    const onDisk = join(up, ref.replace("/uploads/", ""));
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, "utf-8")).toBe("pretend-pdf-bytes");
  });

  it("separates a mixed batch (image vs non-image) in one pass", () => {
    writeFileSync(join(up, "b.pdf"), "pdf-bytes");
    const r = processAttachments([
      { isImage: true, name: "a.png", url: "/uploads/a.png", dataUrl: null },
      { isImage: false, name: "b.pdf", url: "/uploads/b.pdf", dataUrl: null },
    ], up);
    expect(r.images.map((i) => i.name)).toEqual(["a.png"]);
    expect(r.fileAttachments.map((f) => f.name)).toEqual(["b.pdf"]);
  });

  it("is a no-op without an uploads dir (degrade, don't throw)", () => {
    const r = processAttachments([{ isImage: false, name: "x.pdf", url: "/uploads/x.pdf", dataUrl: null }], undefined);
    expect(r).toEqual({ images: [], fileAttachments: [], fileAttachmentNote: "" });
  });
});

// The dangling-/uploads seam (2026-08-31 campaign): a ref whose file is gone
// must be surfaced ONCE with the standard unreadable-attachment note, never
// silently passed along as a "readable" PATH, and never fail the turn.
describe("processAttachments — dangling /uploads refs", () => {
  let up: string;
  beforeAll(() => { up = mkdtempSync(join(tmpdir(), "att-dangle-")); });
  afterAll(() => rmSync(up, { recursive: true, force: true }));

  it("a dangling non-image ref becomes the standard note instead of a readable-PATH claim", () => {
    const r = processAttachments([{ isImage: false, name: "Gone.pdf", url: "/uploads/gone.pdf", dataUrl: null }], up);
    expect(r.fileAttachments).toEqual([]);
    expect(r.fileAttachmentNote).toContain("[Attachment Gone.pdf could not be read (ENOENT)]");
    expect(r.fileAttachmentNote).not.toContain("readable by your file tools");
    // Never leak the absolute on-disk path.
    expect(r.fileAttachmentNote).not.toContain(up);
  });

  it("a readable file and a dangling one in the same batch: the PATH block AND the note block, each listing only its own", () => {
    writeFileSync(join(up, "here.pdf"), "pdf-bytes");
    const r = processAttachments([
      { isImage: false, name: "Here.pdf", url: "/uploads/here.pdf", dataUrl: null },
      { isImage: false, name: "Gone.pdf", url: "/uploads/gone.pdf", dataUrl: null },
    ], up);
    expect(r.fileAttachments).toEqual([{ name: "Here.pdf", ref: "/uploads/here.pdf" }]);
    expect(r.fileAttachmentNote).toContain(`"Here.pdf" → /uploads/here.pdf`);
    expect(r.fileAttachmentNote).toContain("[Attachment Gone.pdf could not be read (ENOENT)]");
  });

  it("a dangling IMAGE ref still passes through — the request-time converter (images-to-openai-parts) is its single surfacer", () => {
    // Filtering images here would surface the failure twice (or, for an
    // image-only send, recreate the empty-user-row 400 class). The converter
    // emits the byte-identical note in-order inside the user message instead.
    const r = processAttachments([{ isImage: true, name: "ghost.png", url: "/uploads/ghost.png", dataUrl: null }], up);
    expect(r.images).toEqual([{ name: "ghost.png", url: "/uploads/ghost.png", filePath: join(up, "ghost.png") }]);
    expect(r.fileAttachmentNote).toBe("");
  });

  it("unreadableAttachmentNote is the byte-exact contract string both seams share", () => {
    expect(unreadableAttachmentNote({ name: "shot.png" }, { code: "ENOENT" }))
      .toBe("[Attachment shot.png could not be read (ENOENT)]");
    expect(unreadableAttachmentNote({ name: "", filePath: "/x/y/pic.jpg" }))
      .toBe("[Attachment pic.jpg could not be read]");
  });
});
