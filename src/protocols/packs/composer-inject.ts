/**
 * Composer Injector — ONE shared primitive for inserting formatted text into
 * modern rich-text web composers (Lexical / contenteditable / native textarea)
 * WITHOUT destroying line breaks.
 *
 * Every social composer (Instagram, X/Twitter, Facebook, Threads, LinkedIn,
 * Discord) shreds newlines when text is entered via a structured `fill`. The
 * fix that actually works is to run a tiny script (browser `evaluate` action)
 * that finds the composer element and populates it the way the framework
 * expects:
 *   - native <textarea>: native value setter + input/change events
 *   - contenteditable / [role=textbox] / Lexical: clear, then insert each line
 *     with insertParagraph between lines and insertText for the content
 *
 * Adding a new site = a selector list + a pack. NEVER another injector.
 *
 * SECURITY: the generated JS only reads/sets the composer element. It is
 * deliberately written to avoid EVERY egress + dynamic-exec pattern in
 * src/browser/guards.ts BLOCKED_EVAL_PATTERNS, so `scanEvaluateScript` returns
 * null (not blocked) for it. Specifically it emits NO `new Image`, NO `.src =`,
 * NO `.action =`, NO `.submit(`, NO `createElement(`, NO `fetch(`, NO `eval(`,
 * NO `new Function`/`Function(` constructor, and — critically — NO lowercase
 * `function` keyword (the guard's `/\bFunction\s*\(/i` pattern is
 * case-INSENSITIVE, so the outer wrapper is an arrow IIFE `(() => { … })()`,
 * never `(function() { … })()`). It also avoids `window[`, `document.cookie`,
 * `localStorage`, and short-string concat. Text/selectors are embedded via
 * JSON.stringify. This robustness is intrinsic to the emitted tokens, not a
 * claim about the blocklist's contents.
 */

/**
 * Normalize composer text: CRLF/CR → LF, collapse 3+ blank lines to a double
 * break (composers ignore excessive spacing anyway). This is the generalized
 * form of the old `formatCaptionForInstagram`.
 */
export function formatComposerText(text: string): string {
	let clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	clean = clean.replace(/\n{3,}/g, "\n\n");
	return clean;
}

/**
 * Build the browser-`evaluate` JS string that inserts `text` into the first
 * matching composer among `selectors`.
 *
 * The text is embedded via JSON.stringify so its outer double quotes are kept
 * and apostrophes/newlines/backslashes survive as data (JSON.stringify does not
 * escape `'`, so single-quoted embedding would break on "Don't"). We embed the
 * whole double-quoted literal directly.
 */
export function buildComposerInjector(text: string, selectors: string[]): string {
	// A valid double-quoted JS string literal for the composer text.
	const escaped = JSON.stringify(text);
	// A valid JS array literal of the selectors (also double-quoted, escaped).
	const selectorList = JSON.stringify(selectors);

	return `
    (() => {
      // Selectors are site-specific and change often — try them in order.
      const selectors = ${selectorList};
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;

        // Focus the element first so the framework treats input as user-driven.
        el.focus();
        el.click();

        if (el.tagName === 'TEXTAREA') {
          // Native textarea — use the native value setter so React/controlled
          // inputs pick up the change, then dispatch input/change.
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          ).set;
          nativeSetter.call(el, ${escaped});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'Text inserted via textarea';
        } else {
          // ContentEditable / Lexical ([data-lexical-editor="true"]) editor.
          // Clear existing content, then insert each line with a real paragraph
          // break between lines so newlines are preserved by the framework.
          el.innerHTML = '';
          const lines = ${escaped}.split('\\n');
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
              document.execCommand('insertParagraph', false, null);
            }
            if (lines[i]) {
              document.execCommand('insertText', false, lines[i]);
            }
          }
          return 'Text inserted via contenteditable';
        }
      }
      return 'ERROR: Could not find composer input element';
    })()
  `.trim();
}

// ── Site selector lists ──────────────────────────────────────────
// A new site = add its selectors here (or in its pack) and reuse the injector.

/** Instagram caption composer selectors (order matters — most specific last). */
export const INSTAGRAM_COMPOSER_SELECTORS = [
	"textarea",
	'[contenteditable="true"]',
	'[role="textbox"]',
	'[aria-label="Write a caption..."]',
	'[aria-label*="caption"]',
	'div[data-lexical-editor="true"]',
];

/** X/Twitter tweet composer (Lexical editor). */
export const TWITTER_COMPOSER_SELECTORS = [
	'[data-testid="tweetTextarea_0"]',
	'[data-testid="tweetTextarea_0"] [data-lexical-editor="true"]',
	'[role="textbox"][data-testid="tweetTextarea_0"]',
	'div[data-lexical-editor="true"]',
	'[contenteditable="true"]',
	'[role="textbox"]',
];

// ── Site registry ────────────────────────────────────────────────
// A new site = one entry here. The generic `protocol_format_composer` tool and
// any per-site pack reuse the SAME injector — no copy-pasted JS ever again.

export interface ComposerSite {
	/** Human label for the tool output. */
	label: string;
	/** Selector list handed to buildComposerInjector. */
	selectors: string[];
	/** Optional character limit for a warning in the tool output. */
	charLimit?: number;
}

export const COMPOSER_SITES: Record<string, ComposerSite> = {
	instagram: { label: "Instagram", selectors: INSTAGRAM_COMPOSER_SELECTORS, charLimit: 2200 },
	twitter: { label: "X / Twitter", selectors: TWITTER_COMPOSER_SELECTORS, charLimit: 280 },
	x: { label: "X / Twitter", selectors: TWITTER_COMPOSER_SELECTORS, charLimit: 280 },
};

/**
 * Build the ready-to-return tool content for a composer site: formatted text,
 * character/limit accounting, and the browser-`evaluate` injector string. Used
 * by the `protocol_format_composer` tool so index.ts stays a thin wire.
 * Returns `null` for an unknown site.
 */
export function buildComposerToolContent(site: string, rawText: string): string | null {
	const key = site.trim().toLowerCase();
	const cfg = COMPOSER_SITES[key];
	if (!cfg) return null;

	const formatted = formatComposerText(rawText);
	const jsCode = buildComposerInjector(formatted, cfg.selectors);

	const charCount = formatted.length;
	const hashtagCount = (formatted.match(/#\w+/g) || []).length;
	const warnings: string[] = [];
	if (cfg.charLimit && charCount > cfg.charLimit) {
		warnings.push(`⚠️ Text is ${charCount} chars (${cfg.label} limit: ${cfg.charLimit})`);
	}

	return [
		`## Formatted text for ${cfg.label}:`,
		"```",
		formatted,
		"```",
		`Characters: ${charCount}${cfg.charLimit ? `/${cfg.charLimit}` : ""} | Hashtags: ${hashtagCount}`,
		warnings.length ? warnings.join("\n") : "✅ Within limits",
		"",
		`## To insert into ${cfg.label}, use the browser 'evaluate' action with this code:`,
		"```js",
		jsCode,
		"```",
		"",
		"⚠️ After inserting, ALWAYS take a snapshot to verify the text appears exactly ONCE and is properly formatted.",
	].join("\n");
}
