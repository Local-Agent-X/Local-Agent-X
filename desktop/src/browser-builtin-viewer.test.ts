import { describe, it, expect } from "vitest";
import { isBuiltInPdfViewerRequest } from "./browser-builtin-viewer";

const VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html";

describe("isBuiltInPdfViewerRequest", () => {
	it("lets the PDF viewer's own files through", () => {
		for (const file of ["index.html", "main.js", "index.css", "pdf_embedder.css", "pdf_viewer_wrapper.js"]) {
			expect(isBuiltInPdfViewerRequest(`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/${file}`)).toBe(true);
		}
	});

	it("lets the viewer load Chromium's shared WebUI code (the files it was refused in the live app)", () => {
		for (const file of [
			"css/text_defaults_md.css",
			"js/assert.js",
			"lit/v3_0/lit.rollup.js",
			"js/load_time_data.js",
			"mojo/mojo/public/js/bindings.js",
		]) {
			expect(isBuiltInPdfViewerRequest(`chrome://resources/${file}`, VIEWER)).toBe(true);
		}
	});

	it("refuses chrome://resources to anyone but the viewer, and every other chrome:// page", () => {
		expect(isBuiltInPdfViewerRequest("chrome://resources/js/assert.js", "https://example.com/page")).toBe(false);
		expect(isBuiltInPdfViewerRequest("chrome://resources/js/assert.js")).toBe(false);
		expect(isBuiltInPdfViewerRequest("chrome://resources/js/assert.js", "chrome-extension://pppndnondekehijelkdnlihcfehjacfe/x.html")).toBe(false);
		expect(isBuiltInPdfViewerRequest("chrome://settings/", VIEWER)).toBe(false);
	});

	it("leaves every other extension to the egress check (a page probing for installed extensions)", () => {
		expect(isBuiltInPdfViewerRequest("chrome-extension://pppndnondekehijelkdnlihcfehjacfe/jc.98ee31a0.css")).toBe(false);
		expect(isBuiltInPdfViewerRequest("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai.evil.com/index.html")).toBe(false);
	});

	it("never lets a web URL through by naming the viewer's id", () => {
		expect(isBuiltInPdfViewerRequest("https://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html")).toBe(false);
		expect(isBuiltInPdfViewerRequest("https://example.com/chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/x")).toBe(false);
		expect(isBuiltInPdfViewerRequest("https://resources/js/assert.js", VIEWER)).toBe(false);
		expect(isBuiltInPdfViewerRequest("not a url", VIEWER)).toBe(false);
	});
});
