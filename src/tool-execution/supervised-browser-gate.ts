/**
 * Supervised-browser pre-dispatch gate — extracted from pre-dispatch.ts to keep
 * that file under the 400-LOC ceiling. One responsibility: decide whether a
 * `browser.evaluate` call must be forced to the approval path because the user
 * opted into supervision AND the current page origin is not trusted.
 *
 * The trust decision itself lives in the GENERAL mechanism
 * (src/browser/trusted-origins.ts) — this module never names a site. Returns a
 * block descriptor (the reason/recovery the caller wraps in a ToolBlocked) or
 * null to allow. Kept free of ToolBlocked to avoid an import cycle with
 * pre-dispatch.ts.
 */
import { isTrustedOrigin } from "../browser/trusted-origins.js";

export interface SupervisedBrowserBlock {
	reason: string;
	recovery: string;
}

/**
 * When supervised browser mode is on, a `browser.evaluate` on a non-trusted
 * origin is forced to approval. Everything else (mode off, other tools, other
 * browser actions, trusted origins) returns null = no forcing.
 *
 * FAIL SAFE: getCurrentUrl is awaited and any unknowable URL ("" / throw,
 * absorbed by the caller's dep default) is NOT trusted, so it forces approval.
 */
export async function supervisedEvaluateBlock(
	supervisedBrowser: boolean,
	call: { name: string; args: Record<string, unknown> },
	getCurrentUrl: () => string | Promise<string>,
): Promise<SupervisedBrowserBlock | null> {
	if (supervisedBrowser !== true) return null;
	if (call.name !== "browser") return null;
	if ((call.args as { action?: unknown }).action !== "evaluate") return null;

	const currentUrl = await getCurrentUrl();
	if (isTrustedOrigin(currentUrl)) return null;

	return {
		reason:
			"Supervised browser mode is on: running JavaScript (browser.evaluate) on a page whose origin is not on the trusted-origin allowlist requires the user's approval.",
		recovery:
			"Ask the user to approve this browser.evaluate, or navigate to a trusted origin first. To make the browser autonomous again, the user can turn Supervised Browser off in Settings → Security. Don't flip it off yourself to get past this block.",
	};
}
