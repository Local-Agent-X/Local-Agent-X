/**
 * In-app backend interactions (chunk A2) — the ref/text resolution chain and
 * REAL input events for the embedded WebContentsView.
 *
 * Ports the CDP semantics from actions.ts / interactions.ts:
 *   resolution order role+name → visible text (click only) → XPath → stored
 *   coords (click only), retry after 1.5s on a total miss, then once more
 *   after a re-observe. Return strings match interactions.ts shapes exactly —
 *   the model consumes them.
 *
 * Two deliberate improvements over the CDP path:
 *   - Each resolution attempt is ONE isolated-world exec round-trip: the
 *     script finds the element, scrolls it into view, re-reads its rect, and
 *     hit-tests elementFromPoint at the center. If the hit-test misses
 *     (occluded by an overlay) we fall DOWN the chain instead of blind-
 *     clicking, and log it.
 *   - Clicks/typing are dispatched as REAL input events (browserInput →
 *     webContents.sendInputEvent), so isTrusted-gated pages work. When the
 *     desktop refuses input because the HUMAN is driving the view (co-drive
 *     lock), the action returns USER_TOOK_WHEEL with userActive=true so the
 *     tool layer resets the progress guard instead of tripping it.
 */

import type { Page } from "playwright";
import { ObservationRegistry, type DurableRef } from "./observation.js";
import { waitForStability } from "./stability.js";
import {
	browserInput,
	browserLifecycle,
	isUserActiveResult,
	type BridgeInputEvent,
	type BridgeInputModifier,
} from "./bridge-client.js";
import { execChecked } from "./in-app-observe.js";
import {
	asExecResult,
	resolutionScript,
	selectFillScript,
	textSearchScript,
} from "./in-app-scripts.js";
import type { InteractionResult } from "./backend.js";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app.actions");

// ── Constants ─────────

/** Interaction outcome when the desktop's co-drive lock refused agent input:
 *  the human is actively driving the view. Surfaced verbatim to the model;
 *  carried with userActive=true so applyProgressGuard resets instead of
 *  counting the preempted action as a stall. */
export const USER_TOOK_WHEEL =
	"User took the wheel — the human is actively driving the in-app browser view, so this action was " +
	"not delivered. Wait for them to finish (or ask them to hand control back), then retry.";

/** KB1 / plan invariant S1-5: never capture pixels while a credential field
 *  has focus in the co-driven view (the user may be mid-password). The guard
 *  fails CLOSED: focus inside an unreadable cross-origin embed (bank/Stripe/
 *  Plaid/OAuth login) is treated as credential-bearing, so the message names
 *  BOTH reasons — the user needs to know why an innocuous-looking embed blocked
 *  the capture. */
export const CREDENTIAL_CAPTURE_BLOCKED =
	"Screenshot blocked: a credential field is focused in the co-driven browser, " +
	"or focus is inside an embedded frame (treated as credential-bearing since its " +
	"contents can't be inspected). Ask the user to click elsewhere first.";

/** File pickers are native chrome — no input-event or DOM path can drive them
 *  safely. Route to the human (the CDP path has no file-input strategy either;
 *  every locator strategy fails there). */
export const FILE_INPUT_NEEDS_HUMAN =
	"is a file input — file uploads must be done by the user. Ask them to attach the file " +
	"in the co-driven browser, then continue.";

const RESOLVE_RETRY_DELAY_MS = 1_500; // CDP parity: actions.ts waits 1.5s before its second chain pass
const CLICK_TEXT_BUDGET_MS = 12_000; // CDP parity: actions.ts CLICK_TEXT_BUDGET
const CLICK_TEXT_ATTEMPTS = 3;
const TEXT_SCROLL_SETTLE_MS = 400;

// ── Coordinate conversion ─────────

/**
 * CSS px (viewport-relative, from getBoundingClientRect) → the view's own
 * DIP coordinate space (what webContents.sendInputEvent consumes).
 *
 * The view's DIP space matches its content viewport 1:1 at zoom 1. Page zoom
 * (visualViewport.scale ≠ 1) shrinks/grows CSS px relative to DIPs, so we
 * multiply. Device pixel ratio does NOT enter the conversion — DIPs are
 * DPR-independent by definition (a Retina display changes physical pixels,
 * not the DIP grid); `dpr` is accepted so callers pass the full measurement
 * and the invariance is unit-tested, not assumed.
 */
export function cssToViewDip(xCss: number, yCss: number, zoom: number, _dpr: number): { x: number; y: number } {
	return { x: Math.round(xCss * zoom), y: Math.round(yCss * zoom) };
}

/** Cross-platform select-all chord modifier for the fill clear sequence. */
export function selectAllModifier(platform: NodeJS.Platform): BridgeInputModifier {
	return platform === "darwin" ? "meta" : "control";
}

// ── Context ─────────

export interface InAppActionContext {
	viewId: string;
	/** BridgeObservePage via asObservePage — the shared observation adapter. */
	page: Page;
	registry: ObservationRegistry;
	/** Test seam; defaults to process.platform. */
	platform?: NodeJS.Platform;
	/** Test seam; defaults to RESOLVE_RETRY_DELAY_MS. */
	retryDelayMs?: number;
	/** Test seam; defaults to TEXT_SCROLL_SETTLE_MS. */
	settleMs?: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

// ── In-page scripts (isolated world) ─────────

/** Result of one resolution round-trip. Coordinates are CSS px relative to
 *  the viewport, measured AFTER scrollIntoView + hit-test. */
export interface ResolvedTarget {
	found: true;
	via: "role" | "text" | "xpath" | "coords";
	x: number;
	y: number;
	w: number;
	h: number;
	dpr: number;
	zoom: number;
	tag: string;
	type: string;
	editable: boolean;
	/** Set when the hit-test landed on an unrelated-but-benign overlapping
	 *  element (icon, ripple span, styled sibling): the click is dispatched at
	 *  the point anyway — same element a human click would land on. Carries
	 *  the overlapper's tag#id/.class for the result message. */
	through?: string;
}
interface ResolveMiss {
	found: false;
	/** Strategies that MATCHED an element but failed the elementFromPoint
	 *  hit-test (occluded) — logged, never blind-clicked. */
	occluded?: string[];
}
type ResolveOutcome = ResolvedTarget | ResolveMiss;

export function asResolveOutcome(raw: unknown): ResolveOutcome {
	if (raw && typeof raw === "object" && (raw as { found?: unknown }).found === true) {
		return raw as ResolvedTarget;
	}
	const occluded = (raw as { occluded?: unknown } | null)?.occluded;
	return { found: false, occluded: Array.isArray(occluded) ? occluded.map(String) : [] };
}

const SCROLL_ONE_VIEWPORT_SCRIPT =
	"document.scrollingElement && document.scrollingElement.scrollBy(0, document.documentElement.clientHeight)";

// ── Drivers ─────────

/** Pre-exec arbitration (C1): exec-driven MUTATIONS (select .value) don't go
 *  through the desktop input gate, so probe the co-drive lock via the
 *  lifecycle ping first. A failed ping reads as "not active" — the input
 *  path is still enforced desktop-side. */
export async function isViewUserActive(viewId: string): Promise<boolean> {
	try {
		const { ping } = await browserLifecycle("ping", viewId);
		return ping?.userActive === true;
	} catch {
		return false;
	}
}

/** InteractionResult carries only { ok, text } (backend.ts), so the co-drive
 *  refusal is signalled by the EXACT USER_TOOK_WHEEL text — the tool layer
 *  (act.ts) matches it to stamp ToolResult metadata.userActive and reset the
 *  progress breaker. Keep this the single carrier of the signal. */
function userTookWheel(): InteractionResult {
	return { ok: false, text: USER_TOOK_WHEEL };
}

/** Misses carry the LAST pass's occluder diagnostics ("strategy:occluder"),
 *  threaded into the model-facing failure so "occluded" names the actual
 *  obstruction instead of reading as a site bug. */
async function resolveWithRetry(
	ctx: InAppActionContext,
	ref: DurableRef,
	op: "click" | "fill",
): Promise<ResolveOutcome> {
	const delay = ctx.retryDelayMs ?? RESOLVE_RETRY_DELAY_MS;
	let lastOccluded: string[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		const out = asResolveOutcome(await execChecked(ctx.viewId, resolutionScript(ref, op)));
		if (out.found) return out;
		lastOccluded = out.occluded ?? [];
		if (lastOccluded.length > 0) {
			logger.info(
				`[in-app] ref ${ref.id}: hit-test missed for ${lastOccluded.join(",")} (occluded) — refusing blind ${op}`,
			);
		}
		// Pass 1 → wait 1.5s (CDP actions.ts parity); pass 2 → re-observe
		// (interactions.ts clickRefOn/fillRefOn parity); pass 3 → give up.
		if (attempt === 0) await sleep(delay);
		else if (attempt === 1) await ctx.registry.observe(ctx.page).catch(() => {});
	}
	return { found: false, occluded: lastOccluded };
}

function viaMessage(ref: DurableRef, op: "click" | "fill", hit: ResolvedTarget): string {
	// A benign overlapper took the hit-test — say so, so an unexpected outcome
	// reads as "clicked the thing on top" instead of a silent mystery.
	const through = hit.through ? ` (through overlapping ${hit.through})` : "";
	switch (hit.via) {
		case "role":
			return `[${ref.id}] ${op} via role/name (${ref.role} "${ref.name}")${through}`;
		case "text":
			return `[${ref.id}] click via visible text "${ref.name}"${through}`;
		case "xpath":
			return `[${ref.id}] ${op} via XPath${through}`;
		case "coords":
			return `[${ref.id}] click via coords (${hit.x},${hit.y}) — layout-dependent, verify result`;
	}
}

/**
 * Resolve a ref id, transparently recovering a STALE one: on a registry miss,
 * take a fresh observation (refreshing the map) and remap via
 * recoverStaleRef (signature, then unique role+name). The model keeps its old
 * id working across a page re-render instead of burning a turn on
 * "take a fresh observation". An unrecoverable id fails WITH the fresh
 * snapshot so the retry has real refs to aim at.
 */
async function resolveRefOrFail(
	ctx: InAppActionContext,
	refId: number,
): Promise<{ ref: DurableRef; note: string } | { fail: InteractionResult }> {
	const direct = ctx.registry.get(refId);
	if (direct) return { ref: direct, note: "" };
	let snapshot = "";
	try {
		snapshot = ObservationRegistry.format(await ctx.registry.observe(ctx.page));
	} catch { /* recovery below still gets whatever the registry holds */ }
	const ref = ctx.registry.recoverStaleRef(refId);
	if (ref) {
		logger.info(`[in-app] stale ref [${refId}] recovered as [${ref.id}] (${ref.role} "${ref.name}")`);
		return { ref, note: ` (stale ref [${refId}] auto-recovered as [${ref.id}])` };
	}
	return {
		fail: {
			ok: false,
			text: `Ref [${refId}] not found — take a fresh observation${snapshot ? `\n\nCurrent page:\n\n${snapshot}` : ""}`,
		},
	};
}

async function failedWithSnapshot(ctx: InAppActionContext, ref: DurableRef, occluded: string[] = []): Promise<InteractionResult> {
	const refreshed = ObservationRegistry.format(await ctx.registry.observe(ctx.page));
	// Name what intercepted each strategy's hit-test. Without this the model
	// reads "all strategies failed" as a broken site; with it, a real overlay
	// (modal backdrop, toast region) is identified by tag/id/class.
	const why = occluded.length > 0
		? ` Hit-tests were intercepted (strategy:occluder): ${occluded.join(", ")} — an overlay may need dismissing first.`
		: "";
	return {
		ok: false,
		text: `[${ref.id}] ${ref.role} "${ref.name}" — all resolution strategies failed.${why} Re-observe the page.\n\nCurrent page:\n\n${refreshed}`,
	};
}

/** mouseMove → mouseDown → mouseUp (left, clickCount 1) at the target. */
async function clickAtPoint(ctx: InAppActionContext, hit: { x: number; y: number; zoom: number; dpr: number }): Promise<"done" | "userActive"> {
	const { x, y } = cssToViewDip(hit.x, hit.y, hit.zoom, hit.dpr);
	const events: BridgeInputEvent[] = [
		{ type: "mouseMove", x, y },
		{ type: "mouseDown", x, y, button: "left", clickCount: 1 },
		{ type: "mouseUp", x, y, button: "left", clickCount: 1 },
	];
	for (const event of events) {
		if (isUserActiveResult(await browserInput(ctx.viewId, event))) return "userActive";
	}
	return "done";
}

/** Select-all + Delete, then REAL per-character typing (char events). Works
 *  for <input>/<textarea> and contenteditable alike — key events, no .value. */
async function typeReplace(ctx: InAppActionContext, value: string): Promise<"done" | "userActive"> {
	const mod = selectAllModifier(ctx.platform ?? process.platform);
	const events: BridgeInputEvent[] = [
		{ type: "keyDown", keyCode: "a", modifiers: [mod] },
		{ type: "keyUp", keyCode: "a", modifiers: [mod] },
		{ type: "keyDown", keyCode: "Delete" },
		{ type: "keyUp", keyCode: "Delete" },
	];
	for (const ch of value) events.push({ type: "char", keyCode: ch });
	for (const event of events) {
		if (isUserActiveResult(await browserInput(ctx.viewId, event))) return "userActive";
	}
	return "done";
}

export async function clickRefInApp(ctx: InAppActionContext, refId: number): Promise<InteractionResult> {
	const resolved = await resolveRefOrFail(ctx, refId);
	if ("fail" in resolved) return resolved.fail;
	const { ref, note } = resolved;
	const hit = await resolveWithRetry(ctx, ref, "click");
	if (!hit.found) return failedWithSnapshot(ctx, ref, hit.occluded ?? []);
	if ((await clickAtPoint(ctx, hit)) === "userActive") return userTookWheel();
	await waitForStability(ctx.page, { maxWait: 2500 });
	const after = ObservationRegistry.format(await ctx.registry.observe(ctx.page));
	return { ok: true, text: `${viaMessage(ref, "click", hit)}${note}\nPage: ${ctx.page.url()}\n\n${after}` };
}

export async function fillRefInApp(ctx: InAppActionContext, refId: number, value: string): Promise<InteractionResult> {
	const resolved = await resolveRefOrFail(ctx, refId);
	if ("fail" in resolved) return resolved.fail;
	const { ref, note } = resolved;
	const hit = await resolveWithRetry(ctx, ref, "fill");
	if (!hit.found) return failedWithSnapshot(ctx, ref, hit.occluded ?? []);

	if (hit.tag === "INPUT" && hit.type === "file") {
		return { ok: false, text: `[${ref.id}] ${FILE_INPUT_NEEDS_HUMAN}` };
	}
	if (hit.tag === "SELECT") {
		// Exec-driven mutation — arbitrate against the co-drive lock first.
		if (await isViewUserActive(ctx.viewId)) return userTookWheel();
		const res = asExecResult(await execChecked(ctx.viewId, selectFillScript(ref, value)));
		if (!res.ok) {
			return { ok: false, text: `[${ref.id}] fill failed: ${res.error} — re-observe, or use select with a CSS selector` };
		}
		return { ok: true, text: `${viaMessage(ref, "fill", hit)}${note} — ${value.length} chars` };
	}
	if ((await clickAtPoint(ctx, hit)) === "userActive") return userTookWheel();
	if ((await typeReplace(ctx, value)) === "userActive") return userTookWheel();
	return { ok: true, text: `${viaMessage(ref, "fill", hit)}${note} — ${value.length} chars` };
}

export async function clickTextInApp(
	ctx: InAppActionContext,
	text: string,
	budgetMs = CLICK_TEXT_BUDGET_MS,
): Promise<InteractionResult> {
	await waitForStability(ctx.page);
	const deadline = Date.now() + budgetMs;
	for (let attempt = 0; attempt < CLICK_TEXT_ATTEMPTS; attempt++) {
		const raw = await execChecked(ctx.viewId, textSearchScript(text));
		const found = raw && typeof raw === "object" && (raw as { found?: unknown }).found === true
			? (raw as { role?: string; x: number; y: number; dpr: number; zoom: number; note?: string })
			: null;
		if (found) {
			if ((await clickAtPoint(ctx, { x: found.x, y: found.y, zoom: found.zoom, dpr: found.dpr })) === "userActive") {
				return userTookWheel();
			}
			const message = found.role ? `clicked ${found.role} "${text}"` : `clicked visible text "${text}"`;
			// Surface the in-page disambiguation hint (set when several elements
			// tied on score) so the model knows to target a specific ref next time.
			const note = typeof found.note === "string" && found.note ? ` — ${found.note}` : "";
			await waitForStability(ctx.page, { maxWait: 2500 });
			const after = ObservationRegistry.format(await ctx.registry.observe(ctx.page));
			return { ok: true, text: `${message}${note}\nPage: ${ctx.page.url()}\n\n${after}` };
		}
		if (Date.now() >= deadline) break;
		if (attempt < CLICK_TEXT_ATTEMPTS - 1) {
			await execChecked(ctx.viewId, SCROLL_ONE_VIEWPORT_SCRIPT).catch(() => { /* keep searching */ });
			await sleep(ctx.settleMs ?? TEXT_SCROLL_SETTLE_MS);
		}
	}
	return {
		ok: false,
		text: `no clickable element matching text "${text}" found (it may be covered by an overlay — try web_fetch or a different source)`,
	};
}


