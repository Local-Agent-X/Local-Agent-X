// A deck built from a template keeps the template's theme, masters and media,
// keeps exactly the slides named, and lays new slides out on the template's
// own layouts through placeholders. Two templates: a real pptxgenjs deck (one
// unnamed layout, no placeholders → fixed-geometry fallback) and a
// PowerPoint-shaped one with named layouts and placeholders (the branded
// company deck case), built by rewriting the first.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { deckFromTemplate, layoutCatalog, pickLayout } from "./pptx-template.js";
import { slideFileNames, slideText } from "./pptx-edit.js";
import { extractOfficeText } from "../office-text.js";

let plainDeck: Buffer;      // pptxgenjs: 3 slides, layout "DEFAULT", no placeholders
let brandedDeck: Buffer;    // same deck with PowerPoint-style named layouts + placeholders

const TITLE_LAYOUT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title"><p:cSld name="Title Slide"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const CONTENT_LAYOUT = TITLE_LAYOUT
  .replace('type="title"><p:cSld name="Title Slide">', 'type="obj"><p:cSld name="Title and Content">')
  .replace('<p:ph type="ctrTitle"/>', '<p:ph type="title"/>')
  .replace('<p:ph type="subTitle" idx="1"/>', '<p:ph idx="1"/>');

beforeAll(async () => {
  const mod = await import("pptxgenjs");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (mod as any).default ?? mod;
  const pptx = new Ctor();
  const dir = mkdtempSync(join(tmpdir(), "pptx-template-"));
  const fp = join(dir, "template.pptx");
  for (const text of ["Cover: Renesas GaN", "Agenda", "Legal notice"]) {
    pptx.addSlide().addText(text, { x: 0.5, y: 0.5, w: 9, h: 1 });
  }
  await pptx.writeFile({ fileName: fp });
  plainDeck = readFileSync(fp);

  // A PowerPoint-shaped template: two more layouts with names and placeholders,
  // registered on the master and in the content types like PowerPoint does.
  const zip = await JSZip.loadAsync(plainDeck);
  zip.file("ppt/slideLayouts/slideLayout2.xml", TITLE_LAYOUT);
  zip.file("ppt/slideLayouts/slideLayout3.xml", CONTENT_LAYOUT);
  const layoutRels = await zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels")!.async("string");
  zip.file("ppt/slideLayouts/_rels/slideLayout2.xml.rels", layoutRels);
  zip.file("ppt/slideLayouts/_rels/slideLayout3.xml.rels", layoutRels);
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("[Content_Types].xml", ct.replace("</Types>",
    `<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/></Types>`));
  brandedDeck = await zip.generateAsync({ type: "nodebuffer" });
});

async function texts(zip: JSZip): Promise<string[]> {
  const out: string[] = [];
  for (const f of slideFileNames(zip)) out.push(slideText(await zip.file(f)!.async("string")));
  return out;
}

/** Every slide part is registered in all three places, and references a layout that exists. */
async function assertWellFormed(zip: JSZip): Promise<void> {
  const slides = slideFileNames(zip);
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  const presRels = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
  const pres = await zip.file("ppt/presentation.xml")!.async("string");
  expect((pres.match(/<p:sldId\b/g) ?? []).length).toBe(slides.length);
  for (const f of slides) {
    expect(ct, `${f} content type`).toContain(`PartName="/${f}"`);
    expect(presRels, `${f} presentation rel`).toContain(`Target="${f.replace(/^ppt\//, "")}"`);
    const rels = await zip.file(f.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels")!.async("string");
    const layout = rels.match(/Target="\.\.\/(slideLayouts\/slideLayout\d+\.xml)"/)?.[1];
    expect(layout, `${f} layout rel`).toBeTruthy();
    expect(zip.file(`ppt/${layout}`), `${f} layout part exists`).not.toBeNull();
  }
}

describe("layoutCatalog + pickLayout", () => {
  it("reads names and placeholders, picks by name, and falls back to the deck's own layout", async () => {
    const catalog = await layoutCatalog(await JSZip.loadAsync(brandedDeck));
    expect(catalog.map((l) => l.name)).toEqual(["DEFAULT", "Title Slide", "Title and Content"]);
    expect(catalog[1].placeholders).toEqual(['type="ctrTitle"', 'type="subTitle" idx="1"']);
    expect(pickLayout(catalog, "title", catalog[0].path).name).toBe("Title Slide");
    expect(pickLayout(catalog, "content", catalog[0].path).name).toBe("Title and Content");
    // No "Section Header" here: a section slide takes the first layout with a title and a text placeholder.
    expect(pickLayout(catalog, "section", catalog[0].path).name).toBe("Title Slide");
    const plain = await layoutCatalog(await JSZip.loadAsync(plainDeck));
    expect(pickLayout(plain, "content", plain[0].path).name).toBe("DEFAULT");
  });
});

describe("deckFromTemplate", () => {
  it("keeps the named slides, appends the new ones after them, and keeps the template's theme and media", async () => {
    const { zip, result } = await deckFromTemplate(plainDeck, [1, 3], [
      { title: "Why GaN", bullets: ["Lower switching loss", "Smaller magnetics"] },
      { layout: "section", title: "Demo" },
    ]);
    await assertWellFormed(zip);
    expect(result).toEqual({ kept: [1, 3], added: 2, slides: 4, layoutsUsed: ["DEFAULT"] });
    const t = await texts(zip);
    expect(t[0]).toContain("Cover: Renesas GaN");
    expect(t[1]).toContain("Legal notice");
    expect(t[2]).toContain("Why GaN");
    expect(t[2]).toContain("Lower switching loss");
    expect(t[3]).toContain("Demo");
    expect(t.join(" ")).not.toContain("Agenda");
    const theme = await JSZip.loadAsync(plainDeck).then((z) => z.file("ppt/theme/theme1.xml")!.async("string"));
    expect(await zip.file("ppt/theme/theme1.xml")!.async("string")).toBe(theme);
  });

  it("lays new slides out through the template's placeholders when its layouts have them", async () => {
    const { zip, result } = await deckFromTemplate(brandedDeck, [], [
      { title: "GaN Solar Training", body: "Renesas field session" },
      { title: "Agenda", bullets: ["Basics", "Topologies"] },
    ]);
    await assertWellFormed(zip);
    expect(result.layoutsUsed).toEqual(["Title Slide", "Title and Content"]);
    const slides = slideFileNames(zip);
    expect(slides).toHaveLength(2);
    const first = await zip.file(slides[0])!.async("string");
    // Placeholder shapes carry the layout's ph attributes and an empty spPr:
    // geometry is inherited from the layout, not drawn.
    expect(first).toContain('<p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/>');
    expect(first).toContain('<p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>');
    expect(first).not.toContain('txBox="1"'); // no fixed-geometry fallback boxes on this template
    const second = await zip.file(slides[1])!.async("string");
    expect(second).toContain('<p:ph type="title"/>');
    expect(second).toContain('<p:ph idx="1"/>');
    expect(second).toContain("<a:t>Topologies</a:t>");
  });

  it("the result reads back through the read tool's extractor, slide by slide", async () => {
    const { zip } = await deckFromTemplate(plainDeck, [2], [{ title: "Closing", bullets: ["Questions"] }]);
    const dir = mkdtempSync(join(tmpdir(), "pptx-template-"));
    const fp = join(dir, "out.pptx");
    writeFileSync(fp, await zip.generateAsync({ type: "nodebuffer" }));
    const text = await extractOfficeText(fp, readFileSync(fp));
    expect(text).toContain("--- Slide 1 ---\nAgenda");
    expect(text).toContain("--- Slide 2 ---\nClosing\nQuestions");
  });

  it("refuses an out-of-range keep and an empty build", async () => {
    await expect(deckFromTemplate(plainDeck, [4], [])).rejects.toThrow(/keep_slides names slide 4/);
    await expect(deckFromTemplate(plainDeck, [], [])).rejects.toThrow(/Nothing to build/);
    await expect(deckFromTemplate(Buffer.from("PK\u0003\u0004 nope"), [], [{ title: "x" }])).rejects.toThrow();
  });
});
