import { describe, it, expect } from "vitest";
import { isBuiltInPdfViewerRequest } from "./browser-builtin-viewer";

describe("isBuiltInPdfViewerRequest", () => {
	it("lets the PDF viewer's own files through", () => {
		for (const file of ["index.html", "main.js", "index.css", "pdf_embedder.css", "pdf_viewer_wrapper.js"]) {
			expect(isBuiltInPdfViewerRequest(`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/${file}`)).toBe(true);
		}
	});

	it("leaves every other extension to the egress check (a page probing for installed extensions)", () => {
		expect(isBuiltInPdfViewerRequest("chrome-extension://pppndnondekehijelkdnlihcfehjacfe/jc.98ee31a0.css")).toBe(false);
		expect(isBuiltInPdfViewerRequest("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai.evil.com/index.html")).toBe(false);
	});

	it("never lets a web URL through by naming the viewer's id", () => {
		expect(isBuiltInPdfViewerRequest("https://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html")).toBe(false);
		expect(isBuiltInPdfViewerRequest("https://example.com/chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/x")).toBe(false);
		expect(isBuiltInPdfViewerRequest("not a url")).toBe(false);
	});
});
