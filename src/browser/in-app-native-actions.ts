/**
 * Native ref-interaction fast-path for the in-app (Electron) backend.
 *
 * When the embedded view's CDP endpoint is connected, click/fill BY REF try a
 * BOUNDED, FRAME-AWARE native action on the real CDP-backed Page before the
 * isolated-world bridge chain: resolveFrame(real, ref) picks the correct
 * Playwright Frame (so a ref inside a same-origin iframe — every field in the
 * Thrive Shopventory PO form — resolves in that frame, not the main document),
 * then locator(xpath).click/fill runs with a SHORT timeout. Native fill fires
 * the focus/input/change sequence React-Select-style widgets need to commit.
 *
 * This corrects the reverted "Job A ch4a" without reintroducing its cost:
 *   - ch4a ran ref.xpath on the MAIN frame only → iframe refs hit the wrong
 *     document. Fixed here by resolveFrame.
 *   - A naive reuse of the external clickRefOn/fillRefOn is UNBOUNDED (30s
 *     Playwright default), so a miss hangs ~30s before falling back — the
 *     regression this file exists to avoid. Fixed here by NATIVE_ACTION_TIMEOUT.
 *
 * Every entry returns null (never throws) on no-CDP / miss / timeout so the
 * caller falls through PROMPTLY to the bridge chain, which still owns SELECT,
 * file inputs, and occlusion hit-testing. Egress-safe: no route()/Fetch/
 * newContext — these only drive an already-hardened view.
 */
import type { Page } from "playwright";
import { resolveFrame } from "./actions.js";
import { realDrivingPage } from "./in-app-driving-page.js";
import { ObservationRegistry, type DurableRef } from "./observation.js";
import { waitForStability } from "./stability.js";
import type { InAppActionContext } from "./in-app-actions.js";
import type { InteractionResult } from "./backend.js";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app-native");

/** Short native-action budget: a miss must fall back to the bridge PROMPTLY —
 *  Playwright's 30s default would stall every unresolvable ref (the ch4a-reuse
 *  regression that hung 'fill' ~29s before wedge recovery). */
const NATIVE_ACTION_TIMEOUT_MS = 3_000;

/** Resolve the real Page + a live ref with an xpath, or null to fall back. */
async function nativeTarget(
	ctx: InAppActionContext,
	refId: number,
): Promise<{ real: Page; ref: DurableRef } | null> {
	const real = await realDrivingPage(ctx.viewId);
	if (!real) return null;
	const ref = ctx.registry.recoverStaleRef(refId);
	if (!ref || !ref.xpath) return null;
	return { real, ref };
}

/** Native click by ref (bounded, frame-aware), or null to fall through. */
export async function nativeClickRef(ctx: InAppActionContext, refId: number): Promise<InteractionResult | null> {
	const t = await nativeTarget(ctx, refId);
	if (!t) return null;
	try {
		const frame = resolveFrame(t.real, t.ref);
		await frame.locator(`xpath=${t.ref.xpath}`).click({ timeout: NATIVE_ACTION_TIMEOUT_MS });
		await waitForStability(ctx.page, { maxWait: 2500 });
		const after = ObservationRegistry.format(await ctx.registry.observe(ctx.page));
		return { ok: true, text: `[${t.ref.id}] click (native) via ${t.ref.role} "${t.ref.name}"\nPage: ${ctx.page.url()}\n\n${after}` };
	} catch (e) {
		logger.info(`native click ref ${refId} missed (${(e as Error).message.split("\n")[0]}) — bridge fallback`);
		return null;
	}
}

/** Native fill by ref (bounded, frame-aware), or null to fall through. A
 *  SELECT/file/non-fillable target throws → the bridge chain owns those. */
export async function nativeFillRef(ctx: InAppActionContext, refId: number, value: string): Promise<InteractionResult | null> {
	const t = await nativeTarget(ctx, refId);
	if (!t) return null;
	try {
		const frame = resolveFrame(t.real, t.ref);
		await frame.locator(`xpath=${t.ref.xpath}`).fill(value, { timeout: NATIVE_ACTION_TIMEOUT_MS });
		return { ok: true, text: `[${t.ref.id}] fill (native) via ${t.ref.role} "${t.ref.name}" — ${value.length} chars` };
	} catch (e) {
		logger.info(`native fill ref ${refId} missed (${(e as Error).message.split("\n")[0]}) — bridge fallback`);
		return null;
	}
}
