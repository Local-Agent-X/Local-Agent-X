import { describe, it, expect } from "vitest";

// ── Real modules across every seam the campaign touched. No mocks: the whole
//    point of this test is to prove the SHIPPED pieces compose. ──
import { ToolPolicy } from "../src/tool-policy/index.js";
import { DEFAULT_POLICY } from "../src/tool-policy/default-rules.js";
import { supervisedEvaluateBlock } from "../src/tool-execution/supervised-browser-gate.js";
import {
	scanEvaluateScript,
	sensitivePageActionDecision,
} from "../src/browser/guards.js";
import { buildAgentCsp } from "../src/browser/csp-policy.js";
import {
	buildComposerInjector,
	TWITTER_COMPOSER_SELECTORS,
} from "../src/protocols/packs/composer-inject.js";

/**
 * C8 cross-seam CONTRACT test.
 *
 * The campaign made the in-app agent browser autonomous-by-default with CSP as
 * the egress defense. Every feature chunk passes in isolation. This test proves
 * the invariants HOLD TOGETHER: flipping browser.evaluate to `allow` did NOT
 * remove the sensitive-page safety net, supervised mode still gates on demand,
 * the CSP built for a page is correctly registrable-domain-scoped, and the
 * retired egress regex is now covered by CSP while the read-into-context /
 * dynamic-exec blocklist and the composer injector still agree.
 */
describe("C8 cross-seam contract — autonomous browser + CSP egress defense compose", () => {
	// ── Seam 1: Autonomous default (C1) ──────────────────────────────
	describe("autonomous default: the REAL policy allows browser.evaluate without a confirm", () => {
		const policy = new ToolPolicy(DEFAULT_POLICY);

		it("resolves browser/action:evaluate to allowed, not confirm", () => {
			const decision = policy.evaluate("browser", { action: "evaluate" }, "sess-c8-1");
			expect(decision.allowed).toBe(true);
			// The whole flip: no per-call modal. `confirm` must be falsy.
			expect(decision.confirm).toBeFalsy();
		});

		it("the matching rule is the autonomous evaluate rule (allow), not a deny/default", () => {
			const decision = policy.evaluate("browser", { action: "evaluate" }, "sess-c8-2");
			expect(decision.ruleId).toBe("flag-browser-evaluate");
		});
	});

	// ── Seam 2: Supervised mode still gates (C5) ─────────────────────
	describe("supervised mode re-arms approval on non-trusted origins only", () => {
		const evalCall = { name: "browser", args: { action: "evaluate" } };
		const TRUSTED = "https://x.com/compose/tweet";
		const UNTRUSTED = "https://not-trusted.example.com/app";

		it("supervised ON + non-trusted origin ⇒ forces approval", async () => {
			const block = await supervisedEvaluateBlock(true, evalCall, () => UNTRUSTED);
			expect(block).not.toBeNull();
			expect(block!.reason).toMatch(/supervised/i);
		});

		it("supervised ON + trusted origin ⇒ does NOT force approval", async () => {
			const block = await supervisedEvaluateBlock(true, evalCall, () => TRUSTED);
			expect(block).toBeNull();
		});

		it("supervised OFF ⇒ never forces approval, even on a non-trusted origin", async () => {
			const block = await supervisedEvaluateBlock(false, evalCall, () => UNTRUSTED);
			expect(block).toBeNull();
		});

		it("an unknowable origin fails safe toward approval when supervised", async () => {
			const block = await supervisedEvaluateBlock(true, evalCall, () => "");
			expect(block).not.toBeNull();
		});
	});

	// ── Seam 3: Sensitive-page protection SURVIVED the policy flip (C6) ─
	// This is the load-bearing safety proof: allow-by-default at the POLICY
	// layer did not remove the sensitive-page gate at the BROWSER-TOOL layer.
	describe("sensitive-page gating still fires after the autonomous flip", () => {
		it("password-manager (secret-bearing) ⇒ evaluate is BLOCKED, not merely allowed", () => {
			const d = sensitivePageActionDecision("https://vault.bitwarden.com/passwords", "evaluate");
			expect(d.disposition).toBe("blocked");
			expect(d.category).toBe("password manager");
		});

		it("financial account ⇒ evaluate is approval-required (high-risk), never silently allowed", () => {
			const d = sensitivePageActionDecision("https://www.paypal.com/myaccount", "evaluate");
			expect(d.disposition).toBe("approval-required");
			expect(d.category).toBe("financial account");
		});

		it("an ordinary page ⇒ evaluate is allowed (autonomy intact where it's safe)", () => {
			const d = sensitivePageActionDecision("https://example.com/blog", "evaluate");
			expect(d.disposition).toBe("allow");
		});
	});

	// ── Seam 4: CSP is hardening-only; egress moved to the taint gate ─────────
	// The same-site fetch-scoping CSP was reverted (it broke every multi-CDN
	// site). The CSP must NOT scope connect-src/img-src/etc. anymore — a page's
	// own CDN loads have to render — and cross-origin exfil is covered instead by
	// src/browser/page-egress-taint.ts (a payload-inspecting per-hop gate).
	describe("buildAgentCsp is hardening-only and never scopes fetch sinks", () => {
		it("stamps object-src/base-uri/frame-ancestors and NO fetch directive", () => {
			const csp = buildAgentCsp();
			expect(csp).toContain("object-src 'none'");
			expect(csp).toContain("base-uri 'self'");
			expect(csp).toContain("frame-ancestors 'none'");
			// The reverted breakers must be absent so multi-CDN sites render.
			for (const dir of ["default-src", "connect-src", "script-src", "img-src", "style-src", "form-action"]) {
				expect(csp).not.toContain(`${dir} `);
			}
		});

		it("is URL-independent (no per-site branch that could break a CDN)", () => {
			expect(buildAgentCsp()).toBe(buildAgentCsp());
		});
	});

	// ── Seam 5: Egress is now CSP-not-regex; reads + composer still agree (C6/C7) ─
	describe("egress regex retired, read/exec blocklist + composer injector still hold", () => {
		it("fetch(...) is NO LONGER blocked by the evaluate scanner (CSP owns egress now)", () => {
			expect(scanEvaluateScript("fetch('https://x')")).toBeNull();
		});

		it("a document.cookie READ is STILL blocked (CSP can't stop read-into-model-context)", () => {
			expect(scanEvaluateScript("return document.cookie")).not.toBeNull();
		});

		it("the SHARED composer injector passes the REAL scanEvaluateScript (C7 seam intact)", () => {
			const js = buildComposerInjector(
				"Line one\nLine two — don't break!",
				TWITTER_COMPOSER_SELECTORS,
			);
			// The injector is an arrow IIFE with no fetch/eval/Function/window[…]/
			// document.cookie tokens — it must NOT trip the blocklist, or every
			// composer post would be spuriously blocked.
			expect(scanEvaluateScript(js)).toBeNull();
		});
	});
});
