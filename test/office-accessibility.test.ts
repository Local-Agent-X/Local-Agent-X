import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { getRuntimeConfig } from "../src/config.js";
import { imageAltText } from "../src/tools/shared/image-acquire.js";
import { documentTools } from "../src/tools/document-tools.js";
import { presentationTools } from "../src/tools/presentation-tools.js";
import type { ToolDefinition } from "../src/types.js";

const find = (a: ToolDefinition[], n: string) => a.find((t) => t.name === n)!;

describe("imageAltText — accessibility fallback chain", () => {
  it("prefers explicit alt, then caption, then a derived label", () => {
    expect(imageAltText({ alt: "A bar chart of revenue", caption: "Fig 1", source: "x.png" })).toBe("A bar chart of revenue");
    expect(imageAltText({ caption: "Quarterly revenue", source: "x.png" })).toBe("Quarterly revenue");
    expect(imageAltText({ source: "https://example.com/a/photo.jpg" })).toBe("Image from example.com");
    expect(imageAltText({ source: "/ws/sales_chart_q3.png" })).toBe("Image: sales chart q3");
    expect(imageAltText({ source: "" })).toBe("Image");
  });
});

describe("alt text lands in generated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-"));
  beforeAll(async () => {
    // Point the workspace at our temp dir so a local logo embeds, and drop a
    // real 12x12 PNG there.
    getRuntimeConfig().workspace = dir;
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 30, g: 58, b: 95 } } }).png().toBuffer();
    writeFileSync(join(dir, "logo.png"), png);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("Word: image alt text is written into document.xml", async () => {
    const fp = join(dir, "doc.docx");
    const r = await find(documentTools, "document_create").execute({
      file_path: fp, content: "# Report\nBody",
      images: [{ source: "logo.png", alt: "Quarterly revenue chart" }],
    });
    expect(r.isError).toBeFalsy();
    const zip = await JSZip.loadAsync(readFileSync(fp));
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Quarterly revenue chart");
  });

  it("PowerPoint: slide image alt text is written into the slide XML", async () => {
    const fp = join(dir, "deck.pptx");
    const r = await find(presentationTools, "presentation_create").execute({
      file_path: fp,
      slides: JSON.stringify([{ title: "Map", image: { source: "logo.png", alt: "Regional sales map" } }]),
    });
    expect(r.isError).toBeFalsy();
    const zip = await JSZip.loadAsync(readFileSync(fp));
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slide).toContain("Regional sales map");
  });
});
