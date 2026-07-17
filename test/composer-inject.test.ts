import { describe, it, expect } from "vitest";
import {
	buildComposerInjector,
	formatComposerText,
	buildComposerToolContent,
	INSTAGRAM_COMPOSER_SELECTORS,
	TWITTER_COMPOSER_SELECTORS,
} from "../src/protocols/packs/composer-inject.js";
import { buildCaptionInjector, formatCaptionForInstagram } from "../src/protocols/packs/instagram.js";
// The REAL runtime guard the browser evaluate action runs. Importing it here
// means these tests fail if the generated injector would be rejected at
// runtime — this is what would have caught the `function`-keyword defect.
import { scanEvaluateScript } from "../src/browser/guards.js";

// new Function(...) parses the code without running it — proves valid JS syntax.
function assertParses(code: string) {
	// eslint-disable-next-line no-new-func
	return () => new Function(code);
}

// The one blocklist we must never trip: the injector only reads/sets the
// composer element — no egress-shaped patterns.
const EGRESS = /new Image|\.src\s*=|createElement|fetch\(/;

describe("buildComposerInjector — shared primitive", () => {
	it("produces valid JS with NO egress patterns", () => {
		const code = buildComposerInjector("Hello world\nSecond line", TWITTER_COMPOSER_SELECTORS);
		expect(assertParses(code)).not.toThrow();
		expect(code).not.toMatch(EGRESS);
	});

	it("stays egress-clean for every registered selector set", () => {
		for (const sels of [INSTAGRAM_COMPOSER_SELECTORS, TWITTER_COMPOSER_SELECTORS]) {
			const code = buildComposerInjector("Line one\nLine two", sels);
			expect(code).not.toMatch(EGRESS);
		}
	});

	// MANDATORY: run the REAL browser guard over the generated injector. If the
	// wrapper regresses to a lowercase `function` keyword (matched by the
	// case-insensitive /\bFunction\s*\(/i pattern) or emits any other blocked
	// token, scanEvaluateScript returns the offending pattern instead of null
	// and this fails — exactly the runtime rejection an adversarial reviewer hit.
	it("passes the REAL scanEvaluateScript guard for both selector sets", () => {
		const multiline = "Don't miss it\nIt's a great day\nSee you there!";
		for (const sels of [INSTAGRAM_COMPOSER_SELECTORS, TWITTER_COMPOSER_SELECTORS]) {
			const code = buildComposerInjector(multiline, sels);
			expect(scanEvaluateScript(code)).toBeNull();
		}
	});

	it("JSON-escapes apostrophes and preserves newlines as data", () => {
		const text = "Don't miss it\nSee you there!";
		const code = buildComposerInjector(text, TWITTER_COMPOSER_SELECTORS);
		expect(assertParses(code)).not.toThrow();
		// Apostrophe survives un-mangled inside the JSON string literal.
		expect(code).toContain("Don't miss it");
		// The literal newline is escaped as \n inside the embedded JS literal.
		expect(code).toContain("\\nSee you there!");
	});

	it("handles double quotes, backslashes and newlines together", () => {
		const text = 'She said "hi"\nPath: C:\\Users\nLine\'s end';
		const code = buildComposerInjector(text, INSTAGRAM_COMPOSER_SELECTORS);
		expect(assertParses(code)).not.toThrow();
	});

	it("embeds the site's selector list", () => {
		const code = buildComposerInjector("x", TWITTER_COMPOSER_SELECTORS);
		expect(code).toContain('[data-testid=\\"tweetTextarea_0\\"]');
	});

	it("handles all three composer cases (textarea / contenteditable / lexical)", () => {
		const code = buildComposerInjector("a\nb", INSTAGRAM_COMPOSER_SELECTORS);
		expect(code).toContain("TEXTAREA");
		expect(code).toContain("nativeSetter");
		expect(code).toContain("insertParagraph");
		expect(code).toContain("insertText");
	});

	it("Twitter set keeps tweetTextarea_0 + exercises the Lexical branch", () => {
		expect(TWITTER_COMPOSER_SELECTORS).toContain('[data-testid="tweetTextarea_0"]');
		expect(TWITTER_COMPOSER_SELECTORS).toContain('div[data-lexical-editor="true"]');
		const code = buildComposerInjector("hello\nworld", TWITTER_COMPOSER_SELECTORS);
		// The Lexical/contenteditable branch (execCommand insert path) is emitted.
		expect(code).toContain('data-lexical-editor=\\"true\\"');
		expect(code).toContain("insertParagraph");
		expect(code).toContain("insertText");
	});

	it("uses an arrow IIFE (no `function` keyword the guard would flag)", () => {
		const code = buildComposerInjector("x", TWITTER_COMPOSER_SELECTORS);
		expect(code).toContain("(() => {");
		expect(code).not.toMatch(/\bfunction\b/);
	});
});

describe("formatComposerText", () => {
	it("normalizes CRLF/CR to LF", () => {
		expect(formatComposerText("a\r\nb\rc")).toBe("a\nb\nc");
	});

	it("collapses 3+ newlines to a double break", () => {
		expect(formatComposerText("a\n\n\n\nb")).toBe("a\n\nb");
	});

	it("leaves single and double breaks intact", () => {
		expect(formatComposerText("a\nb\n\nc")).toBe("a\nb\n\nc");
	});
});

describe("Instagram wrappers still delegate equivalently (regression)", () => {
	it("formatCaptionForInstagram === formatComposerText", () => {
		const samples = ["a\r\nb", "x\n\n\n\ny", "clean\ntext"];
		for (const s of samples) {
			expect(formatCaptionForInstagram(s)).toBe(formatComposerText(s));
		}
	});

	// FROZEN golden snapshot of the historical Instagram selector list (verified
	// against `git show HEAD:src/protocols/packs/instagram.ts`). A dropped or
	// reordered selector — which would silently break caption insertion on
	// Instagram — fails here. Order matters: querySelector tries them in turn.
	it("INSTAGRAM_COMPOSER_SELECTORS matches the frozen golden list", () => {
		expect(INSTAGRAM_COMPOSER_SELECTORS).toEqual([
			"textarea",
			'[contenteditable="true"]',
			'[role="textbox"]',
			'[aria-label="Write a caption..."]',
			'[aria-label*="caption"]',
			'div[data-lexical-editor="true"]',
		]);
	});

	it("Instagram injector remains egress-clean and valid", () => {
		const code = buildCaptionInjector("Caption\nWith break");
		expect(assertParses(code)).not.toThrow();
		expect(code).not.toMatch(EGRESS);
	});
});

describe("buildComposerToolContent — generic tool helper", () => {
	it("builds injector + limits for twitter", () => {
		const out = buildComposerToolContent("twitter", "hello\nworld");
		expect(out).not.toBeNull();
		expect(out).toContain("X / Twitter");
		expect(out).toContain("```js");
		expect(out).not.toMatch(EGRESS);
	});

	it("builds injector for instagram (case-insensitive)", () => {
		const out = buildComposerToolContent("Instagram", "cap");
		expect(out).toContain("Instagram");
		expect(out).toContain("/2200");
	});

	it("returns null for an unknown site", () => {
		expect(buildComposerToolContent("myspace", "x")).toBeNull();
	});

	it("warns when over the character limit", () => {
		const out = buildComposerToolContent("twitter", "x".repeat(300));
		expect(out).toContain("limit: 280");
	});
});
