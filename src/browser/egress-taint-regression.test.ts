/**
 * Egress-taint regression (chunk G1) — the in-app browser must stay
 * egress-tainted after the backend swap.
 *
 * The whole point of the taint tracker's egress class is the exfil scenario:
 * "read an authenticated page, then navigate to an attacker host with the
 * secret smuggled in the URL." That defense only fires if the `browser` tool
 * (and its `browser_navigate` synonym) is a recognised egress SINK — the point
 * where the sandbox checks the accumulated taint floor before letting bytes
 * leave the box.
 *
 * Adding a SECOND backend (ElectronInAppBackend) that also navigates could have
 * tempted someone to route in-app navigation around the tool-layer egress gate
 * (it's "just an embedded view, not a real fetch"). It must NOT: an in-app
 * navigate ships a URL to a remote host exactly like the CDP path, so the taint
 * class is keyed on the TOOL NAME, above the backend seam, and survives the
 * swap. This locks that invariant.
 *
 * NOTE: the canonical, exhaustive assertion that the egress class covers every
 * synonym lives in src/tool-execution/capability-class-gates.test.ts ("egress
 * class covers canonical http AND every synonym"). This browser-scoped test is
 * the campaign-local regression tying the invariant specifically to the in-app
 * backend — deliberately narrow, not a re-statement of that suite.
 */
import { describe, expect, it } from "vitest";
import { hasCapability } from "../tool-registry.js";

describe("in-app browser stays egress-tainted (G1 regression)", () => {
	it("the `browser` tool is an egress sink regardless of backend", () => {
		// getBrowserManager() may return the CDP BrowserManager OR the
		// ElectronInAppBackend — the taint class is keyed on the tool name, which
		// is above that seam, so the answer must be backend-independent.
		expect(hasCapability("browser", "egress")).toBe(true);
	});

	it("the `browser_navigate` synonym is egress-tainted (prefix rule)", () => {
		// An in-app navigate ships a URL to a remote host exactly like CDP; the
		// browser_* prefix rule folds the sub-action into the egress class so the
		// "authed read → navigate to attacker host with data in URL" exfil is
		// still gated after the backend swap.
		expect(hasCapability("browser_navigate", "egress")).toBe(true);
	});

	it("vault-only browser sub-tools remain NON-egress (value never enters model context)", () => {
		// The invariant is precise, not a blanket browser_* == egress: the two
		// vault sub-tools write FROM the encrypted vault INTO the page, so no
		// model-visible secret can be exfiltrated through them.
		expect(hasCapability("browser_fill_from_secret", "egress")).toBe(false);
		expect(hasCapability("browser_capture_to_secret", "egress")).toBe(false);
	});
});
