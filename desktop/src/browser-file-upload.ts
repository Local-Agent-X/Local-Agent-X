/**
 * File upload into a browser view — the bridge's "lax:browser-upload" body.
 *
 * A page's file chooser is native chrome: no DOM write and no synthetic key
 * can put a file into `<input type=file>`, and the OS picker it opens is
 * nothing the agent can drive. The DevTools protocol has the one supported
 * way around both, the same one Playwright's setInputFiles uses:
 *
 *   - DOM.setFileInputFiles hands a list of local paths straight to a file
 *     input, hidden or not, and the element fires input/change as if the user
 *     had picked them.
 *   - Page.setInterceptFileChooserDialog turns the chooser a click would open
 *     into a Page.fileChooserOpened event naming the input, so a styled
 *     "Upload" button or drop zone is answered the same way and no OS dialog
 *     ever appears.
 *
 * The server does every judgment before the op reaches here (path
 * confinement, the credential-file and secret-content refusals, the egress
 * gates): this module only moves the files it is given into the view. The
 * element is addressed through the DOM domain, never by running script in the
 * page's main world, so a page cannot redirect the files to another input.
 * Both paths leave the input stamped with the server's mark, so the server
 * reads back what landed from its isolated world.
 */

import type { BrowserUploadRequest } from "./contract/browser-bridge.js";

/** The attribute the server's resolution chain stamps on the element it
 *  settled on (src/browser/in-app-resolve-scripts.ts `p.mark`). */
export const UPLOAD_MARK_ATTR = "data-lax-ref";
/** How long a click gets to open the chooser. A control that opens one does
 *  so synchronously on the click; the wait covers a page that fetches
 *  something first. */
export const CHOOSER_WAIT_MS = 4_000;
// A mark is server-minted from this alphabet; anything else is refused before
// it is spliced into a selector.
const MARK_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

type DebuggerMessageListener = (event: unknown, method: string, params: unknown) => void;

/** The slice of webContents.debugger this module drives; tests supply a fake. */
export interface UploadDebugger {
	isAttached(): boolean;
	attach(protocolVersion: string): void;
	sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
	on(event: "message", listener: DebuggerMessageListener): unknown;
	removeListener(event: "message", listener: DebuggerMessageListener): unknown;
}

export type UploadRequest = Pick<BrowserUploadRequest, "files" | "mark" | "target">;
export interface UploadOutcome { uploadedVia: "input" | "chooser" }

interface DescribedNode { node?: { nodeName?: string; attributes?: string[] } }

/**
 * Deliver `req.files` into the view. `click` dispatches a REAL click at
 * view-DIP coordinates (the caller owns the input path's attribution and the
 * agent cursor); it is used only for a click target.
 */
export async function uploadIntoView(
	dbg: UploadDebugger,
	req: UploadRequest,
	click: (x: number, y: number) => void,
	chooserWaitMs = CHOOSER_WAIT_MS,
): Promise<UploadOutcome> {
	if (!MARK_SHAPE.test(req.mark)) throw new Error("upload mark has an unexpected shape");
	if (req.files.length === 0) throw new Error("upload carries no files");
	// The debugger stays attached afterwards: the Chrome-identity override
	// rides the same session (embedded-chrome-identity.ts), and detaching here
	// would drop it. getDocument also enables the DOM agent, which the search
	// and attribute calls below require.
	if (!dbg.isAttached()) dbg.attach("1.3");
	await dbg.sendCommand("DOM.getDocument", { depth: 0 });
	const target = req.target;
	if (target.kind === "input") {
		const nodeId = await markedFileInput(dbg, req.mark);
		await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: req.files });
		return { uploadedVia: "input" };
	}
	const backendNodeId = await chooserOpenedBy(dbg, () => click(target.x, target.y), req.files.length, chooserWaitMs);
	await dbg.sendCommand("DOM.setFileInputFiles", { backendNodeId, files: req.files });
	// Stamp the input the chooser named, so the server's read-back finds it as
	// it finds a directly marked one.
	const { nodeIds } = (await dbg.sendCommand("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] })) as { nodeIds: number[] };
	await dbg.sendCommand("DOM.setAttributeValue", { nodeId: nodeIds[0], name: UPLOAD_MARK_ATTR, value: req.mark });
	return { uploadedVia: "chooser" };
}

/** The node id of the `<input type=file>` carrying the mark. DOM.performSearch
 *  walks every same-process frame's document, so an input inside a same-origin
 *  iframe is found where a querySelector on the main document would not. */
async function markedFileInput(dbg: UploadDebugger, mark: string): Promise<number> {
	const selector = `[${UPLOAD_MARK_ATTR}="${mark}"]`;
	const { searchId, resultCount } = (await dbg.sendCommand("DOM.performSearch", { query: selector })) as { searchId: string; resultCount: number };
	let nodeId: number;
	try {
		if (!resultCount) throw new Error("the marked element is no longer on the page — re-observe and retry");
		const { nodeIds } = (await dbg.sendCommand("DOM.getSearchResults", { searchId, fromIndex: 0, toIndex: 1 })) as { nodeIds: number[] };
		nodeId = nodeIds[0];
	} finally {
		await dbg.sendCommand("DOM.discardSearchResults", { searchId }).catch(() => { /* best effort */ });
	}
	const { node } = (await dbg.sendCommand("DOM.describeNode", { nodeId })) as DescribedNode;
	if (!isFileInput(node)) {
		throw new Error(`the marked element is <${(node?.nodeName ?? "?").toLowerCase()}>, not a file input`);
	}
	return nodeId;
}

export function isFileInput(node: DescribedNode["node"]): boolean {
	if (!node || node.nodeName?.toUpperCase() !== "INPUT") return false;
	const attrs = node.attributes ?? [];
	for (let i = 0; i + 1 < attrs.length; i += 2) {
		if (attrs[i].toLowerCase() === "type") return attrs[i + 1].toLowerCase() === "file";
	}
	return false; // a typeless <input> is a text box
}

/**
 * Arm chooser interception, fire `trigger`, and return the backend node id of
 * the input whose chooser opened. Interception is disarmed on every exit:
 * while it is on, no OS picker opens in this view for the user either.
 */
async function chooserOpenedBy(dbg: UploadDebugger, trigger: () => void, fileCount: number, waitMs: number): Promise<number> {
	// Page events are delivered only while the domain is enabled.
	await dbg.sendCommand("Page.enable");
	await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
	try {
		const opened = waitForChooser(dbg, waitMs);
		trigger();
		const chooser = await opened;
		if (chooser.mode === "selectSingle" && fileCount > 1) {
			throw new Error("the page's file chooser takes ONE file — pass a single path");
		}
		if (typeof chooser.backendNodeId !== "number") throw new Error("the file chooser did not name its input");
		return chooser.backendNodeId;
	} finally {
		await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => { /* view may be gone */ });
	}
}

function waitForChooser(dbg: UploadDebugger, waitMs: number): Promise<{ mode?: string; backendNodeId?: number }> {
	return new Promise((resolve, reject) => {
		const listener: DebuggerMessageListener = (_event, method, params) => {
			if (method !== "Page.fileChooserOpened") return;
			done();
			resolve((params ?? {}) as { mode?: string; backendNodeId?: number });
		};
		const timer = setTimeout(() => {
			done();
			reject(new Error(
				`no file chooser opened within ${waitMs}ms of the click — the control may not open a picker ` +
				"(it may have opened a menu or navigated instead); target the file input itself or re-observe",
			));
		}, waitMs);
		const done = () => { clearTimeout(timer); dbg.removeListener("message", listener); };
		dbg.on("message", listener);
	});
}
