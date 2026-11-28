// Find/replace inside a .docx, on the XML Word writes: text is replaced once,
// formatting survives where a match sits in one run, and a marker Word split
// across runs is still found.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { replaceTextInDocx, type DocxReplacement } from "./docx-edit.js";

const run = (text: string, bold = false): string =>
  `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t>${text}</w:t></w:r>`;
const para = (...runs: string[]): string => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${runs.join("")}</w:p>`;
const doc = (body: string): string => `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;

/** Each paragraph's runs, in order, as the reader sees them. */
function runsOf(xml: string): string[][] {
  return [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .map((p) => [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((r) => r[1]));
}

async function replaced(body: string, pairs: DocxReplacement[], part = "word/document.xml") {
  const zip = new JSZip();
  zip.file(part, doc(body));
  const result = await replaceTextInDocx(zip, pairs);
  const xml = await zip.file(part)!.async("string");
  return { result, xml, runs: runsOf(xml) };
}

describe("replaceTextInDocx", () => {
  it("replaces a match inside one run and leaves the other runs, and their formatting, alone", async () => {
    const { result, xml, runs } = await replaced(para(run("Dear "), run("{{name}}", true), run(", welcome")), [{ find: "{{name}}", replace: "Alice" }]);
    expect(runs).toEqual([["Dear ", "Alice", ", welcome"]]);
    expect(result).toEqual({ replacements: 1, mergedParagraphs: 0 });
    expect(xml).toContain("<w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">Alice</w:t>");
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it("finds a marker Word split across runs, and says the paragraph was merged", async () => {
    const { result, runs } = await replaced(para(run("{{"), run("name", true), run("}} hi")), [{ find: "{{name}}", replace: "Alice" }]);
    expect(runs).toEqual([["Alice hi", "", ""]]);
    expect(result).toEqual({ replacements: 1, mergedParagraphs: 1 });
  });

  // Was "Acme Corp Corp", counted as 2: the pass for split markers read the
  // paragraph after the first pass had already written the new text into it.
  it("replaces once when the new text contains the old, however many runs the paragraph has", async () => {
    const pairs = [{ find: "Acme", replace: "Acme Corp" }];
    const two = await replaced(para(run("Acme"), run(" rocks", true)), pairs);
    expect(two.runs).toEqual([["Acme Corp", " rocks"]]);
    expect(two.result).toEqual({ replacements: 1, mergedParagraphs: 0 });
    const one = await replaced(para(run("Acme rocks, Acme rules")), pairs);
    expect(one.runs).toEqual([["Acme Corp rocks, Acme Corp rules"]]);
    expect(one.result.replacements).toBe(2);
    const split = await replaced(para(run("Ac"), run("me rocks")), pairs);
    expect(split.runs).toEqual([["Acme Corp rocks", ""]]);
    expect(split.result).toEqual({ replacements: 1, mergedParagraphs: 1 });
  });

  it("a value that contains another key's marker is written as it is", async () => {
    const { runs, result } = await replaced(para(run("{{note}} / {{date}}")), [
      { find: "{{note}}", replace: "due {{date}}" }, { find: "{{date}}", replace: "Friday" },
    ]);
    expect(runs).toEqual([["due {{date}} / Friday"]]);
    expect(result.replacements).toBe(2);
  });

  it("where two finds start at the same place, the longer one is used", async () => {
    const { runs } = await replaced(para(run("{{name}} {{name_full}}")), [
      { find: "{{name", replace: "X" }, { find: "{{name_full}}", replace: "Alice Example" },
    ]);
    expect(runs).toEqual([["X}} Alice Example"]]);
  });

  it("matches the text the reader sees, and writes what it is given as text", async () => {
    const { runs, xml } = await replaced(para(run("A &amp; B")), [{ find: "A & B", replace: "C < D & <w:t>" }]);
    expect(runs).toEqual([["C &lt; D &amp; &lt;w:t&gt;"]]);
    expect(xml).not.toContain("<w:t>C");
  });

  it("does not match across two paragraphs, and leaves a document with no match byte for byte", async () => {
    const body = para(run("end {{na")) + para(run("me}} start"));
    const { result, xml } = await replaced(body, [{ find: "{{name}}", replace: "X" }]);
    expect(result).toEqual({ replacements: 0, mergedParagraphs: 0 });
    expect(xml).toBe(doc(body));
  });

  it("an empty paragraph written self-closed does not hide the one after it", async () => {
    const { runs, result } = await replaced(`<w:p/>${para(run("Dear {{"), run("name}}"))}${para(run("second"))}`, [{ find: "{{name}}", replace: "Alice" }]);
    expect(runs.flat()).toEqual(["Dear Alice", "", "second"]);
    expect(result).toEqual({ replacements: 1, mergedParagraphs: 1 });
  });

  it("reaches the text after a text box, which sits in a paragraph of its own inside the run", async () => {
    const body = `<w:p>${run("before {{a}}")}<w:r><w:pict><w:txbxContent>${para(run("box {{a}}"))}</w:txbxContent></w:pict></w:r>${run("after {{a}}")}</w:p>`;
    const { xml, result } = await replaced(body, [{ find: "{{a}}", replace: "X" }]);
    expect([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1])).toEqual(["before X", "box X", "after X"]);
    expect(result.replacements).toBe(3);
  });

  it("covers headers, footers and notes, ignores an empty find, and touches no other part", async () => {
    const zip = new JSZip();
    for (const part of ["word/document.xml", "word/header1.xml", "word/footer2.xml", "word/footnotes.xml", "word/styles.xml"]) {
      zip.file(part, doc(para(run("{{co}}"))));
    }
    const result = await replaceTextInDocx(zip, [{ find: "", replace: "never" }, { find: "{{co}}", replace: "Acme" }]);
    expect(result.replacements).toBe(4);
    expect(await zip.file("word/styles.xml")!.async("string")).toContain("{{co}}");
    expect(await zip.file("word/footer2.xml")!.async("string")).toContain("Acme");
  });
});
