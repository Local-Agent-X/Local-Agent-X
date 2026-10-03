// @vitest-environment happy-dom
// A chat link to a program shows the program's real name and a "program"
// badge, never the agent's link text: "[Q3 report](workspace/run.cmd)" must not
// read as a report. md() (public/js/shared-md.js) derives the label from the
// rendered href, and the file-link click handler (public/js/shared-dom.js)
// opens the path from the same parse, so the name on the label is the file a
// click opens. These tests pin both halves and the agreement between them. A
// link to another site opens in a browser and runs nothing, so it is never
// labelled.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, win32 } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, "../public/js", file), "utf8");

// The operator token is "tok"; the agent-origin lookup shared-md.js makes at
// load answers with the files-link capability "ft-cap", which /files links
// carry instead of the token.
const agentLookup = Promise.resolve({ ok: true, json: () => ({ origin: "http://127.0.0.1:9", filesLinkToken: "ft-cap" }) });
const { md, linkPath, labelProgramLinks, PROGRAM_EXTENSIONS, agentFilesHref, agentReady } = new Function(
	"AUTH_TOKEN", "fetch",
	`${read("shared-escape.js")}\n${read("shared-md.js")}\nreturn { md, linkPath, labelProgramLinks, PROGRAM_EXTENSIONS, agentFilesHref, agentReady: laxAgentReady };`,
)("tok", () => agentLookup) as {
	md: (s: string) => string;
	linkPath: (href: string) => string;
	labelProgramLinks: (html: string) => string;
	PROGRAM_EXTENSIONS: Set<string>;
	agentFilesHref: (href: string) => string;
	agentReady: Promise<void>;
};
await agentReady;

// The origin the chat page is served from: links on it are the app's own.
const APP = location.origin;

function render(markdown: string) {
	const div = document.createElement("div");
	div.innerHTML = md(markdown);
	return div;
}

function renderLink(markdown: string) {
	const div = render(markdown);
	const a = div.querySelector("a");
	if (!a) throw new Error(`no link rendered for ${markdown}: ${div.innerHTML}`);
	const badge = a.querySelector(".link-program-badge");
	const name = [...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
	return { a, href: a.getAttribute("href") ?? "", name, badge: badge?.textContent ?? null };
}

function expectProgram(markdown: string, name: string) {
	const link = renderLink(markdown);
	expect(link.badge).toBe("program");
	expect(link.name).toBe(name);
	expect(link.a.textContent).not.toContain("report");
	return link;
}

describe("program links show the real filename and a program badge", () => {
	it("a workspace script shows its filename, not the agent's text", () => {
		const link = expectProgram("[report](workspace/evil.cmd)", "evil.cmd");
		expect(link.href).toBe("/files/evil.cmd?ft=ft-cap");
		expect(link.a.classList.contains("file-download")).toBe(true);
	});

	it("a document link carries the files-link capability, never the operator token", () => {
		expect(md("[report](workspace/report.pdf)")).toBe(
			'<p><a href="/files/report.pdf?ft=ft-cap" target="_blank" rel="noopener noreferrer" class="md-link file-download">report</a></p>',
		);
		for (const link of ["[r](/files/a.html)", "[r](/files/a.html?x=1)", "`workspace/notes.md`", "[r](report.docx)"]) {
			expect(md(link), link).toContain("ft=ft-cap");
			expect(md(link), link).not.toContain("token=");
		}
		expect(md("[r](/files/a.html?x=1)")).toContain('href="/files/a.html?x=1&amp;ft=ft-cap"');
	});

	it("a percent-encoded NUL cannot hide the program behind a document extension", () => {
		expectProgram("[report](workspace/evil.cmd%00.pdf)", "evil.cmd");
		expectProgram("`workspace/evil.cmd%00.pdf`", "evil.cmd");
	});

	it("trailing dots and spaces cannot hide the program extension", () => {
		expectProgram("[report](workspace/evil.cmd%2E)", "evil.cmd");
		expectProgram("[report](workspace/evil.cmd.%20)", "evil.cmd");
		expectProgram("[report](workspace/evil.cmd%20)", "evil.cmd");
	});

	it("the extension check ignores case", () => {
		expectProgram("[report](workspace/EVIL.CMD)", "EVIL.CMD");
	});

	it("a '#' in a workspace path is part of the file name; a query or an absolute URL's fragment is not", () => {
		expectProgram("[report](workspace/q3.pdf#.cmd)", "q3.pdf#.cmd");
		const doc = renderLink("[report](workspace/evil.cmd#.pdf)");
		expect(doc.badge).toBeNull();
		expect(linkPath(doc.href)).toBe("/files/evil.cmd#.pdf");
		expect(renderLink("[report](workspace/report.pdf?x=run.cmd)").badge).toBeNull();
		expectProgram(`[report](${APP}/files/setup.exe#notes)`, "setup.exe");
	});

	it("an entity or a quote in the agent's URL stays text in the file name", () => {
		const entity = renderLink("[report](workspace/evil&#46;cmd)");
		expect(entity.badge).toBeNull();
		expect(linkPath(entity.href)).toBe("/files/evil&#46;cmd");
		const quote = renderLink('[report](workspace/evil.cmd"x.pdf)');
		expect(quote.badge).toBeNull();
		expect(linkPath(quote.href)).toBe('/files/evil.cmd"x.pdf');
	});

	it("a `..` decoded from an encoded slash resolves before the name is read", () => {
		expectProgram("[report](workspace/evil.cmd%2Fx%2F..%2F)", "evil.cmd");
		expectProgram("[report](workspace/x%2F..%2Fevil.cmd)", "evil.cmd");
	});

	it("format characters cannot reorder the name on screen", () => {
		expectProgram("[report](workspace/photo%E2%80%AEgpj.cmd)", "photo\uFFFDgpj.cmd");
	});

	it("a link to another site is rendered exactly as before, whatever its path ends in", () => {
		expect(md("[next.js](https://github.com/vercel/next.js)")).toBe(
			'<p><a href="https://github.com/vercel/next.js" target="_blank" rel="noopener noreferrer" class="md-link">next.js</a></p>',
		);
		expect(md("see https://en.wikipedia.org/wiki/Node.js")).toBe(
			'<p>see <a href="https://en.wikipedia.org/wiki/Node.js" target="_blank" rel="noopener noreferrer" class="md-link">https://en.wikipedia.org/wiki/Node.js</a></p>',
		);
		for (const markdown of [
			"[report](https://example.com/dl/setup.exe?v=1)",
			"get https://example.com/tools/install.sh now",
			"[report](http://127.0.0.1:8188/view/run.cmd)",
		]) expect(renderLink(markdown).badge, markdown).toBeNull();
		expect(renderLink("[report](https://example.com/dl/setup.exe?v=1)").name).toBe("report");
	});

	it("a link on the app's own origin or to a local file is labelled", () => {
		expectProgram(`[report](${APP}/files/setup.exe?v=1)`, "setup.exe");
		expectProgram(`get ${APP}/files/tools/install.sh now`, "install.sh");
		expectProgram("[report](file:///C:/Users/pat/workspace/evil.cmd)", "evil.cmd");
		const div = document.createElement("div");
		div.innerHTML = labelProgramLinks('<a href="file:///C:/tools/run.cmd">report</a>');
		expect(div.querySelector(".link-program-badge")?.textContent).toBe("program");
		expect(div.querySelector("a")?.firstChild?.textContent).toBe("run.cmd");
	});

	it("markup with no link is returned without being parsed again", () => {
		const createElement = vi.spyOn(document, "createElement");
		expect(labelProgramLinks("<p>no links here</p>")).toBe("<p>no links here</p>");
		expect(createElement).not.toHaveBeenCalledWith("template");
		createElement.mockRestore();
	});

	it("the list is the owner's ruling, so dropping a type is a deliberate change", () => {
		const ruling = [
			"exe", "com", "scr", "pif", "cpl", "msi", "msp", "msix", "appx", "bat", "cmd", "ps1", "psm1",
			"vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "reg",
			"msc", "chm", "ws", "wsc", "xll", "application", "appref-ms", "inf", "scf",
			"settingcontent-ms", "library-ms", "search-ms", "diagcab", "appinstaller",
			"app", "command", "tool", "scpt", "pkg", "mpkg",
			"sh", "bash", "zsh", "desktop", "appimage", "run", "deb", "rpm",
			"jar", "py", "pyw", "pl", "rb",
		];
		expect([...PROGRAM_EXTENSIONS].sort()).toEqual(ruling.sort());
	});

	it("every listed extension is labelled, and document types are not", () => {
		for (const ext of PROGRAM_EXTENSIONS) expectProgram(`[report](workspace/file.${ext})`, `file.${ext}`);
		for (const ext of ["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "png", "html"]) {
			const link = renderLink(`[report](workspace/file.${ext})`);
			expect(link.badge).toBeNull();
			expect(link.name).toBe("report");
		}
	});
});

// Makes a link invisible and stretches it over the window, so a click anywhere
// lands on it while the agent's own words sit where the user is looking.
const COVER = "opacity:0;position:fixed;inset:0;z-index:2147483647;x:y";

describe("the agent's URL never becomes markup around a program link", () => {
	const breakouts: Record<string, string> = {
		"a workspace link": `[report](workspace/evil.cmd?" style="${COVER})`,
		"a /files/ link": `[report](/files/evil.cmd?" style="${COVER})`,
		"a relative document link": `[report](evil.cmd?" style="${COVER}.pdf)`,
		"an image nested in a link's URL": `[report](workspace/evil.cmd?![x](https://x class=file-download style=${COVER}))`,
		"an image nested in a bare URL": `get ${APP}/files/evil.cmd?![x](https://x class=file-download style=${COVER}) now`,
		"a $\` replacement pattern in a URL": `\`workspace/a class=file-download style=${COVER} b.md\` then [report](/files/evil.cmd?$\`)`,
	};
	for (const [name, markdown] of Object.entries(breakouts)) {
		it(`${name} cannot style the link or hide its badge`, () => {
			const div = render(markdown);
			const program = [...div.querySelectorAll("a")].find((a) => a.querySelector(".link-program-badge"));
			expect(program?.firstChild?.textContent).toBe("evil.cmd");
			expect(program!.className).toMatch(/^md-link( file-download)?$/);
			expect(div.querySelectorAll("[style]:not(.link-program-badge)")).toHaveLength(0);
		});
	}

	it("a quote in a workspace path cannot add attributes to the link", () => {
		const { a } = renderLink(`[report](workspace/evil.cmd" style="${COVER})`);
		expect(a.getAttributeNames().sort()).toEqual(["class", "href", "rel", "target"]);
	});

	it("an image cannot style itself into a screen over the chat", () => {
		const img = render(`![x](data:image/svg+xml,a" style="position:fixed;inset:0;pointer-events:none;z-index:2147483647)`).querySelector("img")!;
		expect(img.getAttributeNames().sort()).toEqual(["alt", "class", "src"]);
	});

	it("an image nested in a URL the early bare-URL pass misses cannot style it", () => {
		const div = render(`_https://x/![x](https://y style=${COVER}).png now`);
		expect(div.querySelector("img")).not.toBeNull();
		expect(div.querySelectorAll("[style]")).toHaveLength(0);
	});

	it("every value md() interpolates into an attribute goes through attr()", () => {
		expect(read("shared-md.js").match(/[\w-]+=(?:"[^"]*|'[^']*|)\$\{(?!attr\()/g)).toBeNull();
	});
});

// What ShellExecute would run for a project-relative path, read independently of
// md(): Node's win32 resolve (as desktop/src/open-project-file.ts resolves), then
// Win32's NUL truncation and trailing dot/space strip.
function programOpened(relativePath: string): string | null {
	const name = win32.basename(win32.resolve("C:\\root", relativePath.split("\0")[0])).replace(/[. ]+$/, "");
	return PROGRAM_EXTENSIONS.has(win32.extname(name).slice(1).toLowerCase()) ? name : null;
}

function loadClickHandler() {
	const handlers: Array<(e: unknown) => void> = [];
	const doc = {
		addEventListener: (type: string, fn: (e: unknown) => void) => {
			if (type === "click") handlers.push(fn);
		},
		getElementById: () => null,
	};
	const openFile = vi.fn();
	const open = vi.fn();
	const win: { desktop?: { isDesktop: boolean; openFile: typeof openFile }; open: typeof open } = {
		desktop: { isDesktop: true, openFile },
		open,
	};
	new Function("document", "window", "linkPath", "agentFilesHref", read("shared-dom.js"))(doc, win, linkPath, agentFilesHref);
	return { click: (target: Element) => handlers[0]({ target, preventDefault() {} }), openFile, open, win };
}

describe("the click opens the file the label names", () => {
	const cases = [
		"[report](workspace/evil.cmd)",
		"[report](workspace/evil.cmd#.pdf)",
		"[report](workspace/report.pdf#.cmd)",
		"[report](workspace/a/files/evil.cmd)",
		"[report](workspace/evil.cmd%2Fx%2F..%2F)",
		"[report](workspace/evil&#46;cmd)",
		"[report](workspace/sub%5Cevil.cmd)",
		"[report](workspace/setup.docx)",
		"[Invoice](workspace/Invoice #42.docx)",
		"`workspace/PO#55.xlsx`",
		`[report](workspace/evil.cmd?" style="${COVER})`,
	];
	for (const markdown of cases) {
		it(markdown, () => {
			const link = renderLink(markdown);
			const h = loadClickHandler();
			h.click(link.badge ? link.a.querySelector(".link-program-badge")! : link.a);
			const opened = h.openFile.mock.calls[0]?.[0] as string | undefined;
			if (opened === undefined) {
				expect(h.open).toHaveBeenCalledWith(link.href, "_blank", "noopener,noreferrer");
				return;
			}
			expect(link.badge ? link.name : null).toBe(programOpened(opened));
		});
	}

	it("a '#' is part of a workspace file name, so the program it names is the one that opens", () => {
		const link = renderLink("[report](workspace/report.pdf#.cmd)");
		expect(link.badge).toBe("program");
		expect(link.name).toBe("report.pdf#.cmd");
		const h = loadClickHandler();
		h.click(link.a);
		expect(h.openFile).toHaveBeenCalledWith("workspace/report.pdf#.cmd");
	});

	it("a '#', '&' or apostrophe in a document's name opens that document", () => {
		const opens: Record<string, string> = {
			"[Invoice](workspace/Invoice #42.docx)": "workspace/Invoice #42.docx",
			"`workspace/PO#55.xlsx`": "workspace/PO#55.xlsx",
			"[PO](PO#55.xlsx)": "workspace/PO#55.xlsx",
			"[R&D](workspace/R&D notes.docx)": "workspace/R&D notes.docx",
			"`workspace/R&D's plan.docx`": "workspace/R&D's plan.docx",
		};
		for (const [markdown, path] of Object.entries(opens)) {
			const h = loadClickHandler();
			h.click(renderLink(markdown).a);
			expect(h.openFile, markdown).toHaveBeenCalledWith(path);
		}
	});

	it("a backtick file link is labelled with the file's own name", () => {
		expect(renderLink("`workspace/R&D's plan.docx`").a.textContent).toBe("📄 R&D's plan.docx");
	});

	// The page is agent-written; as window.opener this window would hand it the
	// operator token and, in the desktop app, window.desktop.
	it("a file opened in a new tab gets no opener and no referrer", () => {
		for (const desktop of [true, false]) {
			const h = loadClickHandler();
			if (!desktop) h.win.desktop = undefined;
			const link = renderLink("[report](workspace/report.pdf)");
			h.click(link.a);
			expect(h.open).toHaveBeenCalledWith(link.href, "_blank", "noopener,noreferrer");
		}
	});

	it("a nested files/ folder opens the linked file, not the folder", () => {
		const h = loadClickHandler();
		h.click(renderLink("[report](workspace/a/files/evil.cmd)").a);
		expect(h.openFile).toHaveBeenCalledWith("workspace/a/files/evil.cmd");
	});
});
