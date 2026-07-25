/**
 * Native ref-interaction fast-path for the in-app (Electron) backend.
 *
 * When the embedded view's CDP endpoint is connected, click/fill BY REF run
 * through the SAME frame-aware resolution the external-Chrome backend uses
 * (clickRefOn/fillRefOn → resolveFrame → role/text/xpath/coords) on the real
 * CDP-backed Page — one source of truth, not a parallel driver. Being
 * frame-aware, it reaches INTO same-origin iframes (the Thrive Shopventory PO
 * form) that the isolated-world bridge chain cannot drive by ref, and native
 * fill dispatches the focus/input/change sequence React-Select-style widgets
 * need to commit.
 *
 * This is the corrected form of the reverted "Job A ch4a": that attempt ran
 * ref.xpath on the MAIN frame only, so an iframe ref hit the wrong document or
 * burned its timeout. Routing through clickRefOn/fillRefOn resolves the correct
 * frame first.
 *
 * Every entry returns null (never throws) on no-CDP / miss / error so the caller
 * falls through to the battle-tested bridge chain, which still owns SELECT,
 * file inputs, and occlusion hit-testing. Egress-safe: no route()/Fetch/
 * newContext is added — these only drive an already-hardened view.
 */
import type { Page } from "playwright";
import { clickRefOn, fillRefOn } from "./interactions.js";
import { realDrivingPage } from "./in-app-driving-page.js";
import type { InAppActionContext } from "./in-app-actions.js";
import type { InteractionResult } from "./backend.js";
import { createLogger } from "../logger.js";

const logger = createLogger("browser.in-app-native");

async function tryNativeRefAction(
	ctx: InAppActionContext,
	run: (real: Page) => Promise<InteractionResult>,
): Promise<InteractionResult | null> {
	const real = await realDrivingPage(ctx.viewId);
	if (!real) return null;
	try {
		const result = await run(real);
		return result.ok ? result : null;
	} catch (e) {
		logger.info(`native ref action missed (${(e as Error).message.split("\n")[0]}) — falling back to bridge chain`);
		return null;
	}
}

/** Native click by ref on the real Page, or null to fall through to the bridge. */
export function nativeClickRef(ctx: InAppActionContext, refId: number): Promise<InteractionResult | null> {
	return tryNativeRefAction(ctx, (real) => clickRefOn(real, ctx.registry, refId));
}

/** Native fill by ref on the real Page, or null to fall through to the bridge. */
export function nativeFillRef(ctx: InAppActionContext, refId: number, value: string): Promise<InteractionResult | null> {
	return tryNativeRefAction(ctx, (real) => fillRefOn(real, ctx.registry, refId, value));
}
