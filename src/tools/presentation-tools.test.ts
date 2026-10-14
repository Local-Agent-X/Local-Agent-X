// add_slide documents a `title` (the family's "create/from_outline/add_slide"
// title metadata) and used to ignore it; the new file now carries it.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { presentationTools } from "./presentation-tools.js";

const tool = presentationTools[0];
const dir = mkdtempSync(join(tmpdir(), "presentation-tool-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("presentation add_slide", () => {
  it("applies the title metadata to the new single-slide file", async () => {
    const original = join(dir, "deck.pptx");
    writeFileSync(original, "placeholder — add_slide only derives the output name from it");
    const r = await tool.execute({
      action: "add_slide", file_path: original, position: 3, title: "Q3 Addendum",
      slide: JSON.stringify({ title: "Extra", bullets: ["one"] }),
    });
    expect(r.isError).toBeFalsy();
    const out = String(r.metadata?.file_path);
    expect(out.endsWith("deck_slide_3.pptx")).toBe(true);
    const zip = await JSZip.loadAsync(readFileSync(out));
    const core = await zip.file("docProps/core.xml")!.async("string");
    expect(core).toContain("<dc:title>Q3 Addendum</dc:title>");
  });
});
