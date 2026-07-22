/**
 * Scroll driver for the embedded WebContentsView, split from in-app-actions.ts
 * (400-LOC gate). Ref-targeted scroll reuses the A2 resolution script (the
 * scrollIntoView side effect); page scrolls dispatch a REAL mouseWheel event
 * so co-drive arbitration applies exactly as it does for clicks.
 */

import { waitForStability } from "./stability.js";
import { browserInput, isUserActiveResult } from "./bridge-client.js";
import { execChecked } from "./in-app-observe.js";
import { resolutionScript } from "./in-app-scripts.js";
import type { ScrollOptions } from "./backend.js";
import {
	asResolveOutcome,
	cssToViewDip,
	USER_TOOK_WHEEL,
	type InAppActionContext,
} from "./in-app-actions.js";

const DEFAULT_SCROLL_AMOUNT_PX = 600;

const SCROLL_METRICS_SCRIPT = `(() => {
	const d = document.scrollingElement || document.documentElement;
	return {
		vw: document.documentElement.clientWidth,
		vh: document.documentElement.clientHeight,
		top: d.scrollTop,
		height: d.scrollHeight,
		dpr: (typeof devicePixelRatio === "number" && devicePixelRatio) || 1,
		zoom: (typeof visualViewport !== "undefined" && visualViewport && visualViewport.scale) || 1,
	};
})()`;

interface ScrollMetrics { vw: number; vh: number; top: number; height: number; dpr: number; zoom: number }

function asScrollMetrics(raw: unknown): ScrollMetrics {
	const m = (raw ?? {}) as Partial<Record<keyof ScrollMetrics, unknown>>;
	const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
	return {
		vw: num(m.vw, 1280),
		vh: num(m.vh, 800),
		top: num(m.top, 0),
		height: num(m.height, 800),
		dpr: num(m.dpr, 1),
		zoom: num(m.zoom, 1),
	};
}

export async function scrollInApp(ctx: InAppActionContext, opts: ScrollOptions): Promise<string> {
	if (opts.refId !== undefined) {
		const ref = ctx.registry.recoverStaleRef(opts.refId);
		if (!ref) return `Ref [${opts.refId}] not found — re-observe first`;
		// The resolution script scrolls the element into view as a side effect;
		// an occluded hit-test still means the scroll happened.
		const out = asResolveOutcome(await execChecked(ctx.viewId, resolutionScript(ref, "click")));
		if (!out.found && !(out.occluded && out.occluded.length > 0)) {
			return `Could not scroll ref [${opts.refId}]: element not found — re-observe first`;
		}
		await waitForStability(ctx.page, { maxWait: 1500 });
		return `Scrolled ref [${opts.refId}] into view`;
	}
	const m = asScrollMetrics(await execChecked(ctx.viewId, SCROLL_METRICS_SCRIPT));
	const amount = opts.amount ?? DEFAULT_SCROLL_AMOUNT_PX;
	const dir = opts.direction ?? "down";
	// CSS scroll delta, positive = down — scrollPage's window.scrollBy semantics.
	let cssDelta: number;
	if (dir === "top") cssDelta = -m.top;
	else if (dir === "bottom") cssDelta = Math.max(0, m.height - m.top - m.vh);
	else cssDelta = dir === "up" ? -amount : amount;
	const center = cssToViewDip(m.vw / 2, m.vh / 2, m.zoom, m.dpr);
	// Electron mouseWheel: positive deltaY scrolls UP (wheel-tick convention) — invert.
	const result = await browserInput(ctx.viewId, {
		type: "mouseWheel",
		x: center.x,
		y: center.y,
		deltaX: 0,
		deltaY: -cssDelta,
	});
	if (isUserActiveResult(result)) return USER_TOOK_WHEEL;
	await waitForStability(ctx.page, { maxWait: 1500 });
	return `Scrolled ${dir} (${amount}px)`;
}
