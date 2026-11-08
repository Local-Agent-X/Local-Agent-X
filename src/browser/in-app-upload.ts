/**
 * In-app upload driver — hands local files to the file chooser a ref names,
 * the way Playwright's setInputFiles does, over the B1 bridge
 * ("lax:browser-upload", desktop/src/browser-file-upload.ts).
 *
 * Two shapes of target, decided by what the ref resolves to:
 *   - the `<input type=file>` itself. It is almost always hidden behind a
 *     styled label or button, so it is found by IDENTITY (stable id, XPath,
 *     name, or the page's only file input — in-app-upload-scripts.ts) with no
 *     hit-test, stamped with a one-shot mark, and the desktop sets its files
 *     through the DOM domain.
 *   - any other control (an "Upload" button, a drop zone). The click/fill
 *     resolution chain finds a clickable point as it would for a click; the
 *     desktop arms chooser interception, clicks there for real, and answers
 *     the chooser the click opened. No OS picker appears either way.
 *
 * Every judgment about the FILES happened before this runs: the tool layer
 * confined and scanned them (tools/browser-tools/upload.ts) and the policy
 * gates judged the call as egress. What landed is read back from the isolated
 * world and reported by name and size — our own files, never page content.
 */

import { browserUpload, BridgeOpError } from "./bridge-client.js";
import { execChecked } from "./in-app-observe.js";
import { asExecResult } from "./in-app-scripts.js";
import { fileInputMarkScript, uploadReadbackScript } from "./in-app-upload-scripts.js";
import {
	cssToViewDip,
	failedWithSnapshot,
	isViewUserActive,
	resolveRefOrFail,
	resolveWithRetry,
	userTookWheel,
	viaMessage,
	type InAppActionContext,
	type ResolvedTarget,
} from "./in-app-actions.js";
import { ObservationRegistry, type DurableRef } from "./observation.js";
import { waitForStability } from "./stability.js";
import type { InteractionResult } from "./backend.js";
import type { BrowserUploadRequest } from "../desktop-contract/browser-bridge.js";

type UploadTarget = BrowserUploadRequest["target"];

/** A fresh mark per call, in the alphabet the desktop accepts. */
export function mintUploadMark(now = Date.now(), rand = Math.random()): string {
	return `up-${now.toString(36)}-${Math.floor(rand * 0xffffff).toString(36)}`;
}

function recordsFileInput(ref: DurableRef): boolean {
	return ref.tag.toUpperCase() === "INPUT" && ref.type.toLowerCase() === "file";
}

function isFileInputHit(hit: ResolvedTarget): boolean {
	return hit.tag === "INPUT" && hit.type === "file";
}

/** Stamp the ref's file input by identity. Returns the message fragment
 *  naming how it was found, or null when no file input answers to the ref. */
async function markFileInput(ctx: InAppActionContext, ref: DurableRef, mark: string): Promise<string | null> {
	const res = asExecResult(await execChecked(ctx.viewId, fileInputMarkScript(ref, mark)));
	if (!res.ok) return null;
	const r = res as { via?: string; key?: string };
	switch (r.via) {
		case "exact": return `via ${r.key || "stable id"}`;
		case "xpath": return "via XPath";
		case "name": return `via file input named "${ref.name}"`;
		default: return "via the page's only file input";
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function uploadRefInApp(ctx: InAppActionContext, refId: number, files: string[]): Promise<InteractionResult> {
	const resolved = await resolveRefOrFail(ctx, refId);
	if ("fail" in resolved) return resolved.fail;
	const { ref, note } = resolved;
	// Pre-exec arbitration, as for a <select>: the input path mutates the DOM
	// without passing the desktop input gate, and the click path dispatches
	// input the human may be in the middle of.
	if (await isViewUserActive(ctx.viewId)) return userTookWheel();

	const mark = mintUploadMark();
	let target: UploadTarget | null = null;
	let how = "";
	// A ref observed as the file input itself is resolved by identity first:
	// the hit-test chain would spend its retries on an element that is hidden
	// by design.
	if (recordsFileInput(ref)) {
		how = (await markFileInput(ctx, ref, mark)) ?? "";
		if (how) target = { kind: "input" };
	}
	if (!target) {
		const hit = await resolveWithRetry(ctx, ref, "click", mark);
		if (hit.found) {
			target = isFileInputHit(hit) ? { kind: "input" } : { kind: "click", ...cssToViewDip(hit.x, hit.y, hit.zoom, hit.dpr) };
			how = viaMessage(ref, "upload", hit).replace(/^\[\d+\] upload /, "");
		} else {
			// Not clickable and not recorded as a file input — the ref may still
			// BE one (observed under a label's name): one identity pass before
			// giving up.
			how = (await markFileInput(ctx, ref, mark)) ?? "";
			if (!how) return failedWithSnapshot(ctx, ref, hit.occluded ?? []);
			target = { kind: "input" };
		}
	}

	try {
		await browserUpload(ctx.viewId, { files, mark, target });
	} catch (e) {
		if (!(e instanceof BridgeOpError)) throw e;
		const detail = e.message.replace(/^browser upload failed \(viewId=[^)]*\): /, "");
		return { ok: false, text: `[${ref.id}] upload failed: ${detail}` };
	}

	const back = asExecResult(await execChecked(ctx.viewId, uploadReadbackScript(mark))) as
		{ ok: boolean; names?: string[]; sizes?: number[]; multiple?: boolean };
	const names = Array.isArray(back.names) ? back.names : [];
	if (!back.ok || names.length === 0) {
		return { ok: false, text: `[${ref.id}] upload did not land: the page's file input holds no file afterwards — re-observe and retry, or target the file input itself` };
	}
	const sizes = Array.isArray(back.sizes) ? back.sizes : [];
	const listed = names.map((n, i) => `${n}${typeof sizes[i] === "number" ? ` (${formatSize(sizes[i])})` : ""}`).join(", ");
	const through = target.kind === "click" ? " through the file chooser" : "";
	await waitForStability(ctx.page, { maxWait: 2500 });
	const after = ObservationRegistry.format(await ctx.registry.observe(ctx.page));
	return {
		ok: true,
		text: `[${ref.id}] upload ${how}${through}${note} — ${names.length} file${names.length === 1 ? "" : "s"}: ${listed}\nPage: ${ctx.page.url()}\n\n${after}`,
	};
}
