import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { spreadsheetTools } from "./spreadsheet-tools.js";
import { documentTools } from "./document-tools.js";
import { pdfTools } from "./pdf-tools.js";
import { presentationTools } from "./presentation-tools.js";
import { writeTool } from "./read-write-tools.js";
import type { ToolDefinition } from "../types.js";

/**
 * Drift alarm for the structured-write normalization invariant.
 *
 * Every STRUCTURED writer family (spreadsheet write/edit, document create,
 * pdf create, presentation create) must route user-visible text through the
 * cleanText seam (shared/office-md.ts): single-pass HTML-entity decode
 * (named + numeric, with the NBSP-to-plain-space policy) followed by NFC
 * normalization. Each test drives the REAL tool end-to-end with one shared
 * fixture and reads the artifact back through the strongest channel that
 * exists for that format. If a future writer (or a refactor of an existing
 * one) bypasses the seam, exactly one of these tests names the family that
 * drifted.
 *
 * The generic `write` tool is the deliberate negative control: it is
 * byte-fidelity BY DESIGN (code, CSV, config must round-trip verbatim), so
 * this file also pins that nobody "helpfully" normalizes it later.
 */

// One shared fixture: a named entity, a numeric entity, a numeric NBSP, and
// a DECOMPOSED character (e + combining acute U+0301, written as explicit
// escapes so no editor/toolchain silently composes it) - every axis of the
// seam. This source file stays pure ASCII on purpose.
const FIXTURE = "Nona&rsquo;s Cafe\u0301 Steak&#160;Frites&#8482;";
// After the seam: &rsquo; -> U+2019, e+U+0301 -> U+00E9 (NFC),
// &#160; -> plain space (NBSP policy), &#8482; -> U+2122.
const NORMALIZED = "Nona\u2019s Caf\u00E9 Steak Frites\u2122";

// resolveAgentPath passes ABSOLUTE paths through untouched, so absolute temp
// paths exercise the real generators without any workspace setup (same
// approach as test/office-theme-render.test.ts).
const dir = mkdtempSync(join(tmpdir(), "swn-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tool = (tools: ToolDefinition[], name: string): ToolDefinition => {
	const t = tools.find((x) => x.name === name);
	if (!t) throw new Error(`tool ${name} not found`);
	return t;
};

/** The contract, applied to whatever plain text a reader gives back. */
function expectNormalized(text: string): void {
	expect(text).not.toContain("&#"); // numeric entity leaked undecoded
	expect(text).not.toContain("&rsquo;"); // named entity leaked undecoded
	expect(text).not.toContain("\u00A0"); // NBSP survived the space policy
	expect(text).not.toContain("\u0301"); // combining mark not NFC-composed
	expect(text).toContain(NORMALIZED);
}

describe("structured-write normalization contract - one test per writer family", () => {
	it("spreadsheet write -> read back via the spreadsheet tool's own read action", async () => {
		const fp = join(dir, "write.xlsx");
		const spreadsheet = tool(spreadsheetTools, "spreadsheet");
		const w = await spreadsheet.execute({ action: "write", file_path: fp, data: JSON.stringify([{ Item: FIXTURE }]) });
		expect(w.isError).toBeFalsy();
		const r = await spreadsheet.execute({ action: "read", file_path: fp });
		expect(r.isError).toBeFalsy();
		expectNormalized(r.content);
	});

	it("spreadsheet edit -> read back via the spreadsheet tool's own read action", async () => {
		const fp = join(dir, "edit.xlsx");
		const spreadsheet = tool(spreadsheetTools, "spreadsheet");
		const w = await spreadsheet.execute({ action: "write", file_path: fp, data: JSON.stringify([{ Item: "placeholder" }]) });
		expect(w.isError).toBeFalsy();
		const e = await spreadsheet.execute({ action: "edit", file_path: fp, cell: "A2", value: FIXTURE });
		expect(e.isError).toBeFalsy();
		const r = await spreadsheet.execute({ action: "read", file_path: fp });
		expect(r.isError).toBeFalsy();
		expectNormalized(r.content);
	});

	it("document create -> read back via document_read (mammoth text extraction)", async () => {
		const fp = join(dir, "doc.docx");
		const document = tool(documentTools, "document");
		const w = await document.execute({ action: "create", file_path: fp, content: FIXTURE });
		expect(w.isError).toBeFalsy();
		const r = await document.execute({ action: "read", file_path: fp });
		expect(r.isError).toBeFalsy();
		expectNormalized(r.content);
	});

	it("pdf create -> read back via pdf_read (pdf-parse text extraction)", async () => {
		const fp = join(dir, "doc.pdf");
		const pdf = tool(pdfTools, "pdf");
		const w = await pdf.execute({ action: "create", file_path: fp, content: FIXTURE });
		expect(w.isError).toBeFalsy();
		const r = await pdf.execute({ action: "read", file_path: fp });
		expect(r.isError).toBeFalsy();
		expectNormalized(r.content);
	});

	it("presentation create -> read back from the slide XML (no pptx reader exists)", async () => {
		const fp = join(dir, "deck.pptx");
		const presentation = tool(presentationTools, "presentation");
		const w = await presentation.execute({
			action: "create",
			file_path: fp,
			slides: JSON.stringify([{ title: "Menu", bullets: [FIXTURE] }]),
		});
		expect(w.isError).toBeFalsy();
		// Strongest available channel: unzip the real artifact and decode the
		// slide's <a:t> text runs. XML-unescape (&amp; LAST) so a bypassed
		// fixture - stored as "Nona&amp;rsquo;s" - decodes back to the literal
		// "&rsquo;" the contract hunts for.
		const zip = await JSZip.loadAsync(readFileSync(fp));
		const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
		const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
			.map((m) => m[1]
				.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
				.replace(/&amp;/g, "&"))
			.join("\n");
		expectNormalized(text);
	});
});

describe("negative control - the generic write tool is byte-fidelity by design", () => {
	it("write round-trips the fixture VERBATIM (entities and combining mark intact)", async () => {
		const fp = join(dir, "verbatim.txt");
		const r = await writeTool.execute({ path: fp, content: FIXTURE });
		expect(r.isError).toBeFalsy();
		// Exact bytes back: nobody normalizes code/CSV/plain text "helpfully".
		expect(readFileSync(fp, "utf-8")).toBe(FIXTURE);
	});
});
