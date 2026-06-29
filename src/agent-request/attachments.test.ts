import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { processAttachments } from "./attachments.js";

// Locks the prepare-request END of the attachment seam: the rule "a non-image
// upload must hand the model a readable /uploads PATH" used to be inline and
// silently regressed (non-images were dropped, 404'ing every PDF/doc).
describe("processAttachments", () => {
  let up: string;
  beforeAll(() => { up = mkdtempSync(join(tmpdir(), "att-unit-")); });
  afterAll(() => rmSync(up, { recursive: true, force: true }));

  it("routes a non-image upload to a PATH note (model must not be left with only the display name)", () => {
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
