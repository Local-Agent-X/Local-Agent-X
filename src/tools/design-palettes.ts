/**
 * Archetype palettes — every color the builder needs, as a ROLE, in both modes.
 *
 * Why roles instead of "a background and an accent": a builder handed two hexes
 * invents the other twenty it needs — a hover tint, a border, a muted label, the
 * text that sits on a solid button — and invented values are where a palette
 * stops looking designed. Each token below answers exactly one question ("what
 * color is a card that the pointer is over?"), so nothing has to be guessed.
 *
 * Every token carries a LIGHT and a DARK value and is emitted as
 * `light-dark(<light>, <dark>)`, so an archetype is not a light-mode design with
 * a dark-mode chore attached — one token set drives both and neither can rot.
 * The brief tells the builder to declare `color-scheme: light dark` on :root,
 * which is what arms that function.
 *
 * Values are OKLCH because it is perceptually uniform: a hover that is "one step
 * darker" is the same lightness delta on every hue, so the ramps stay even
 * across archetypes instead of drifting the way hand-picked hex does. Lightness
 * is deliberately laddered on a shared skeleton (see the LADDER comment) so the
 * archetypes differ by hue and chroma — their character — and not by accident.
 *
 * Contrast is not a matter of taste and is not left to review: design-contrast.test.ts
 * computes the WCAG ratio for every text/background and text-on-solid pair in BOTH
 * modes, for every palette here, and fails the build below 4.5:1. The anti-patterns
 * have always demanded that ratio; this is the first thing that verifies it.
 *
 * Data only — no logic. The composition into a brief lives in design-brief.ts.
 */

/** A token's [light, dark] values. Both required: a one-mode token is the bug. */
export type TokenPair = readonly [light: string, dark: string];

/**
 * Shared lightness LADDER, so surfaces stack the same way in every archetype:
 *
 *   light   0.99 bg · 0.975 bg-subtle · 1 surface · 0.955 hover
 *           0.925 border-subtle · 0.835 border · 0.53 text-muted · 0.24 text
 *   dark    0.16 bg · 0.19 bg-subtle · 0.21 surface · 0.25 hover
 *           0.27 border-subtle · 0.37 border · 0.72 text-muted · 0.96 text
 *
 * The border step sits further from its neighbours than the eye would guess it
 * needs to: a 0.875/0.33 edge measures below 1.5:1 and reads as nothing.
 *
 * An archetype departs from the ladder only where its character demands it
 * (the portfolio's near-black light mode, the wellness airiness) — never by
 * accident.
 */
export interface PaletteTokens {
	/** Page background — the furthest-back surface. */
	bg: TokenPair;
	/** A recessed band or well ON the page background (section stripes, sidebars). */
	bgSubtle: TokenPair;
	/** A card / panel that sits ABOVE the page background. */
	surface: TokenPair;
	/** That same card under the pointer, and the resting fill of a secondary control. */
	surfaceHover: TokenPair;
	/** Hairline separators inside a component (table rows, list dividers). */
	borderSubtle: TokenPair;
	/** The visible edge of a card, input, or secondary button. */
	border: TokenPair;
	/** Secondary text — labels, captions, help. Still meets 4.5:1 on bg. */
	textMuted: TokenPair;
	/** Primary body and heading text. */
	text: TokenPair;
	/** A tinted background carrying the brand (selected row, badge, callout). */
	accentSubtle: TokenPair;
	/** The edge of an accent-tinted element, and the focus ring. */
	accentBorder: TokenPair;
	/** The solid brand fill — primary buttons, active nav, key data marks. */
	accent: TokenPair;
	/** That solid fill under the pointer. */
	accentHover: TokenPair;
	/** Text and icons ON TOP of `accent`. Not always white — that is the point. */
	accentContrast: TokenPair;
	/** Semantic only, never decoration: confirmed, positive, gain. */
	success: TokenPair;
	/** Semantic only: needs attention, pending, caution. */
	warn: TokenPair;
	/** Semantic only: destructive, failed, loss. */
	danger: TokenPair;
}

export type PaletteId =
	| "modern-web-app" | "fintech" | "analytics-dashboard" | "ecommerce"
	| "developer-tool" | "health-wellness" | "creative-portfolio"
	| "saas-product" | "marketing-landing";

/** Semantic trio shared by the archetypes with no reason to diverge. Success and
 *  danger sit at the same lightness so a gain and a loss carry equal weight. */
const SEMANTIC = {
	success: ["oklch(0.52 0.13 152)", "oklch(0.72 0.15 152)"],
	warn: ["oklch(0.55 0.13 75)", "oklch(0.79 0.14 80)"],
	danger: ["oklch(0.52 0.19 27)", "oklch(0.7 0.17 27)"],
} as const satisfies Pick<PaletteTokens, "success" | "warn" | "danger">;

export const PALETTES: Record<PaletteId, PaletteTokens> = {
	// Cool neutral, jade accent. The fallback archetype deliberately avoids the
	// default blue button — the most-reached-for choice reads as unstyled.
	"modern-web-app": {
		bg: ["oklch(0.99 0.003 250)", "oklch(0.16 0.012 250)"],
		bgSubtle: ["oklch(0.975 0.005 250)", "oklch(0.19 0.014 250)"],
		surface: ["oklch(1 0 0)", "oklch(0.21 0.014 250)"],
		surfaceHover: ["oklch(0.955 0.006 250)", "oklch(0.25 0.016 250)"],
		borderSubtle: ["oklch(0.925 0.007 250)", "oklch(0.27 0.016 250)"],
		border: ["oklch(0.835 0.009 250)", "oklch(0.37 0.018 250)"],
		textMuted: ["oklch(0.53 0.015 250)", "oklch(0.72 0.018 250)"],
		text: ["oklch(0.24 0.02 250)", "oklch(0.96 0.004 250)"],
		accentSubtle: ["oklch(0.95 0.035 180)", "oklch(0.26 0.045 180)"],
		accentBorder: ["oklch(0.82 0.07 180)", "oklch(0.38 0.07 180)"],
		accent: ["oklch(0.52 0.1 180)", "oklch(0.62 0.1 180)"],
		accentHover: ["oklch(0.46 0.1 180)", "oklch(0.68 0.1 180)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.16 0.02 180)"],
		...SEMANTIC,
	},

	// Deep navy character in both modes; blue is semantically right here, so it
	// earns its place rather than being the default reach.
	fintech: {
		bg: ["oklch(0.985 0.005 255)", "oklch(0.17 0.024 258)"],
		bgSubtle: ["oklch(0.965 0.008 255)", "oklch(0.2 0.026 258)"],
		surface: ["oklch(1 0 0)", "oklch(0.22 0.028 258)"],
		surfaceHover: ["oklch(0.95 0.01 255)", "oklch(0.26 0.03 258)"],
		borderSubtle: ["oklch(0.92 0.011 255)", "oklch(0.28 0.03 258)"],
		border: ["oklch(0.83 0.014 255)", "oklch(0.38 0.032 258)"],
		textMuted: ["oklch(0.52 0.025 255)", "oklch(0.72 0.028 258)"],
		text: ["oklch(0.23 0.03 255)", "oklch(0.96 0.008 258)"],
		accentSubtle: ["oklch(0.95 0.04 255)", "oklch(0.27 0.06 255)"],
		accentBorder: ["oklch(0.81 0.09 255)", "oklch(0.4 0.1 255)"],
		accent: ["oklch(0.52 0.16 255)", "oklch(0.62 0.15 255)"],
		accentHover: ["oklch(0.46 0.16 255)", "oklch(0.68 0.14 255)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.17 0.03 255)"],
		...SEMANTIC,
	},

	// Quiet chrome so the data reads. Categorical series live in the archetype's
	// extra note — they are chart marks, not UI roles.
	"analytics-dashboard": {
		bg: ["oklch(0.975 0.005 255)", "oklch(0.16 0.014 255)"],
		bgSubtle: ["oklch(0.955 0.007 255)", "oklch(0.19 0.016 255)"],
		surface: ["oklch(1 0 0)", "oklch(0.21 0.016 255)"],
		surfaceHover: ["oklch(0.955 0.008 255)", "oklch(0.25 0.018 255)"],
		borderSubtle: ["oklch(0.925 0.008 255)", "oklch(0.27 0.018 255)"],
		border: ["oklch(0.835 0.011 255)", "oklch(0.37 0.02 255)"],
		textMuted: ["oklch(0.53 0.018 255)", "oklch(0.72 0.02 255)"],
		text: ["oklch(0.24 0.025 255)", "oklch(0.96 0.005 255)"],
		accentSubtle: ["oklch(0.95 0.04 225)", "oklch(0.26 0.055 225)"],
		accentBorder: ["oklch(0.81 0.08 225)", "oklch(0.39 0.09 225)"],
		accent: ["oklch(0.52 0.13 225)", "oklch(0.64 0.13 225)"],
		accentHover: ["oklch(0.46 0.13 225)", "oklch(0.7 0.12 225)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.16 0.025 225)"],
		...SEMANTIC,
	},

	// Warm stone neutrals so product imagery carries the color.
	ecommerce: {
		bg: ["oklch(0.985 0.006 75)", "oklch(0.17 0.01 60)"],
		bgSubtle: ["oklch(0.965 0.009 75)", "oklch(0.2 0.012 60)"],
		surface: ["oklch(1 0 0)", "oklch(0.22 0.012 60)"],
		surfaceHover: ["oklch(0.955 0.011 75)", "oklch(0.26 0.014 60)"],
		borderSubtle: ["oklch(0.93 0.011 75)", "oklch(0.28 0.014 60)"],
		border: ["oklch(0.84 0.014 75)", "oklch(0.38 0.016 60)"],
		textMuted: ["oklch(0.52 0.018 60)", "oklch(0.72 0.018 60)"],
		text: ["oklch(0.23 0.02 60)", "oklch(0.96 0.006 60)"],
		accentSubtle: ["oklch(0.95 0.045 150)", "oklch(0.26 0.055 150)"],
		accentBorder: ["oklch(0.82 0.09 150)", "oklch(0.38 0.09 150)"],
		accent: ["oklch(0.51 0.13 150)", "oklch(0.63 0.14 150)"],
		accentHover: ["oklch(0.45 0.13 150)", "oklch(0.69 0.13 150)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.17 0.03 150)"],
		...SEMANTIC,
	},

	// Terminal-adjacent: near-black dark mode, 1px edges instead of shadow.
	"developer-tool": {
		bg: ["oklch(0.98 0.004 255)", "oklch(0.15 0.012 255)"],
		bgSubtle: ["oklch(0.96 0.006 255)", "oklch(0.18 0.014 255)"],
		surface: ["oklch(1 0 0)", "oklch(0.2 0.014 255)"],
		surfaceHover: ["oklch(0.95 0.007 255)", "oklch(0.24 0.016 255)"],
		borderSubtle: ["oklch(0.92 0.008 255)", "oklch(0.26 0.016 255)"],
		border: ["oklch(0.83 0.01 255)", "oklch(0.36 0.018 255)"],
		textMuted: ["oklch(0.52 0.016 255)", "oklch(0.72 0.02 255)"],
		text: ["oklch(0.23 0.02 255)", "oklch(0.95 0.006 255)"],
		accentSubtle: ["oklch(0.95 0.04 200)", "oklch(0.25 0.05 200)"],
		accentBorder: ["oklch(0.81 0.08 200)", "oklch(0.38 0.08 200)"],
		accent: ["oklch(0.51 0.11 200)", "oklch(0.66 0.12 200)"],
		accentHover: ["oklch(0.45 0.11 200)", "oklch(0.72 0.11 200)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.15 0.025 200)"],
		...SEMANTIC,
	},

	// Airy and low-saturation; the lightest ladder of the set on purpose.
	"health-wellness": {
		bg: ["oklch(0.99 0.008 160)", "oklch(0.18 0.014 165)"],
		bgSubtle: ["oklch(0.97 0.012 160)", "oklch(0.21 0.016 165)"],
		surface: ["oklch(1 0 0)", "oklch(0.23 0.016 165)"],
		surfaceHover: ["oklch(0.96 0.014 160)", "oklch(0.27 0.018 165)"],
		borderSubtle: ["oklch(0.935 0.015 160)", "oklch(0.29 0.018 165)"],
		border: ["oklch(0.845 0.019 160)", "oklch(0.39 0.02 165)"],
		textMuted: ["oklch(0.52 0.022 165)", "oklch(0.73 0.022 165)"],
		text: ["oklch(0.24 0.025 165)", "oklch(0.96 0.008 165)"],
		accentSubtle: ["oklch(0.95 0.045 165)", "oklch(0.27 0.05 165)"],
		accentBorder: ["oklch(0.83 0.085 165)", "oklch(0.39 0.085 165)"],
		accent: ["oklch(0.52 0.11 165)", "oklch(0.66 0.12 165)"],
		accentHover: ["oklch(0.46 0.11 165)", "oklch(0.72 0.11 165)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.18 0.03 165)"],
		...SEMANTIC,
	},

	// True monochrome — zero chroma in the neutrals so the work carries all color.
	"creative-portfolio": {
		bg: ["oklch(0.985 0 0)", "oklch(0.13 0 0)"],
		bgSubtle: ["oklch(0.96 0 0)", "oklch(0.16 0 0)"],
		surface: ["oklch(1 0 0)", "oklch(0.18 0 0)"],
		surfaceHover: ["oklch(0.94 0 0)", "oklch(0.22 0 0)"],
		borderSubtle: ["oklch(0.91 0 0)", "oklch(0.25 0 0)"],
		border: ["oklch(0.82 0 0)", "oklch(0.35 0 0)"],
		textMuted: ["oklch(0.52 0 0)", "oklch(0.72 0 0)"],
		text: ["oklch(0.2 0 0)", "oklch(0.97 0 0)"],
		accentSubtle: ["oklch(0.95 0.04 25)", "oklch(0.25 0.06 25)"],
		accentBorder: ["oklch(0.82 0.09 25)", "oklch(0.38 0.1 25)"],
		accent: ["oklch(0.53 0.18 25)", "oklch(0.64 0.18 25)"],
		accentHover: ["oklch(0.47 0.18 25)", "oklch(0.7 0.16 25)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.14 0.02 25)"],
		...SEMANTIC,
	},

	// Amber brand: the accent is LIGHT, so its contrast text is ink, not white.
	// That inversion is exactly what a single hard-coded "white on brand" gets
	// wrong, and why accentContrast is a token instead of an assumption.
	"saas-product": {
		bg: ["oklch(0.99 0.003 265)", "oklch(0.17 0.013 265)"],
		bgSubtle: ["oklch(0.97 0.005 265)", "oklch(0.2 0.015 265)"],
		surface: ["oklch(1 0 0)", "oklch(0.22 0.015 265)"],
		surfaceHover: ["oklch(0.955 0.007 265)", "oklch(0.26 0.017 265)"],
		borderSubtle: ["oklch(0.925 0.008 265)", "oklch(0.28 0.017 265)"],
		border: ["oklch(0.835 0.01 265)", "oklch(0.38 0.019 265)"],
		textMuted: ["oklch(0.53 0.016 265)", "oklch(0.72 0.019 265)"],
		text: ["oklch(0.24 0.022 265)", "oklch(0.96 0.005 265)"],
		accentSubtle: ["oklch(0.95 0.05 70)", "oklch(0.27 0.055 70)"],
		accentBorder: ["oklch(0.84 0.1 70)", "oklch(0.42 0.09 70)"],
		accent: ["oklch(0.76 0.15 70)", "oklch(0.78 0.15 70)"],
		accentHover: ["oklch(0.7 0.15 70)", "oklch(0.84 0.13 70)"],
		accentContrast: ["oklch(0.22 0.04 70)", "oklch(0.2 0.04 70)"],
		...SEMANTIC,
	},

	// Warm ink and a hot coral CTA — energy without reaching for the gradient.
	"marketing-landing": {
		bg: ["oklch(0.99 0.004 40)", "oklch(0.15 0.012 30)"],
		bgSubtle: ["oklch(0.97 0.007 40)", "oklch(0.18 0.014 30)"],
		surface: ["oklch(1 0 0)", "oklch(0.2 0.014 30)"],
		surfaceHover: ["oklch(0.955 0.009 40)", "oklch(0.24 0.016 30)"],
		borderSubtle: ["oklch(0.93 0.009 40)", "oklch(0.26 0.016 30)"],
		border: ["oklch(0.84 0.012 40)", "oklch(0.36 0.018 30)"],
		textMuted: ["oklch(0.52 0.018 30)", "oklch(0.72 0.02 30)"],
		text: ["oklch(0.21 0.022 30)", "oklch(0.97 0.006 30)"],
		accentSubtle: ["oklch(0.95 0.045 25)", "oklch(0.25 0.06 25)"],
		accentBorder: ["oklch(0.82 0.095 25)", "oklch(0.39 0.1 25)"],
		accent: ["oklch(0.55 0.19 25)", "oklch(0.64 0.18 25)"],
		accentHover: ["oklch(0.49 0.19 25)", "oklch(0.7 0.16 25)"],
		accentContrast: ["oklch(0.99 0 0)", "oklch(0.15 0.025 25)"],
		...SEMANTIC,
	},
};

/** CSS custom-property name for each token — the names the builder must emit. */
export const TOKEN_CSS_NAMES: Record<keyof PaletteTokens, string> = {
	bg: "--bg",
	bgSubtle: "--bg-subtle",
	surface: "--surface",
	surfaceHover: "--surface-hover",
	borderSubtle: "--border-subtle",
	border: "--border",
	textMuted: "--text-muted",
	text: "--text",
	accentSubtle: "--accent-subtle",
	accentBorder: "--accent-border",
	accent: "--accent",
	accentHover: "--accent-hover",
	accentContrast: "--accent-contrast",
	success: "--success",
	warn: "--warn",
	danger: "--danger",
};
