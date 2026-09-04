/**
 * Design-system data — one EXACT, committed system per archetype.
 *
 * These are the values the builder must implement verbatim: a role-mapped
 * palette in both modes (design-palettes.ts), an exact font stack + type scale
 * with weights and letter-spacing, and exact radius/shadow/spacing. Vague mood
 * prose ("a modern sans", "navy or slate") produces generic output because a
 * model with no visual taste of its own fills the gaps with slop; exact values
 * give it a real system to execute.
 *
 * TYPEFACES ARE THE IDENTITY, and every archetype gets a DIFFERENT one. The
 * single most reported tell of a machine-made page is the same safe UI sans on
 * every site — a model reaches for it because it dominates the training data,
 * which is exactly what makes it read as unchosen. Each face below is picked for
 * the archetype's job (engineered figures for finance, a high-contrast serif for
 * a portfolio, a soft display for wellness) and all of them are SIL Open Font
 * License, so a build may legitimately self-host them; the anti-patterns carry
 * the rule that the license file ships alongside the font files.
 *
 * Fonts lead with a named webface but always fall back to a system stack, so the
 * design holds even where an external font can't load (the static preview blocks
 * external CDNs). The builder self-hosts the named face on the framework path or
 * renders the system fallback — either way the scale/weights/color carry the look.
 *
 * Every value here is original — a coherent system authored for the archetype,
 * not lifted from any product's identity.
 *
 * Data only. The classifier + renderer live in design-brief.ts.
 */
import type { DesignArchetype } from "./design-brief.js";

export const NEUTRAL_ARCHETYPE: DesignArchetype = {
	id: "modern-web-app",
	name: "Modern Web App",
	matchers: [],
	palette: "modern-web-app",
	style: "Clean, contemporary, content-first — polish through restraint, one clear center of gravity per view.",
	typography:
		"'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif. Scale: h1 30px/800/-0.02em · h2 20px/700/-0.01em · body 16px/400/1.6 · label 13px/600. The weight gap between headings and body is doing the hierarchy work — do not flatten it.",
	geometry:
		"Radius: 8px controls / 12px cards. Shadow: 0 1px 2px rgba(0,0,0,.06), 0 6px 16px rgba(0,0,0,.05). Spacing: 4px base (4/8/12/16/24/32/48).",
	layout: "Header → primary content → supporting sections → footer. Card/list groupings with generous gutters; one clear primary action per view.",
};

export const ARCHETYPES: DesignArchetype[] = [
	{
		id: "fintech",
		name: "Fintech & Trust",
		matchers: [
			/\b(fintech|finance|financial|banking|bank)\b/i,
			/\b(payments?|payroll|wallet|billing|invoic\w*)\b/i,
			/\b(trading|trader|traders|invest\w*|brokerage|broker|stocks?|equit(?:y|ies)|hedge fund|crypto|defi|ledger|budget\w*|expense)\b/i,
		],
		palette: "fintech",
		style: "Precise, calm, trustworthy — accuracy communicated through alignment and generous spacing. Numbers are first-class citizens.",
		typography:
			"'IBM Plex Sans', system-ui, sans-serif; money and metrics in 'IBM Plex Mono', ui-monospace, monospace with `font-variant-numeric: tabular-nums` so columns align digit-for-digit. Scale: h1 32px/700/-0.02em · h2 22px/600/-0.01em · body 15px/400/1.5 · caption 13px/500.",
		geometry:
			"Radius: 6px controls / 10px cards / 14px panels. Shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.06). Spacing: 4px base.",
		extra: "--success and --danger are the gain/loss pair. Semantic only: a number is green because it went up, never because green looks nice. Never encode gain/loss by color alone — carry a sign or an arrow too.",
		layout: "Key figures/balances top, then charts, then detailed tables. Dense but legible; clear separation between at-a-glance and drill-down.",
	},
	{
		id: "analytics-dashboard",
		name: "Data & Analytics Dashboard",
		matchers: [
			/\b(analytics|metrics?|kpis?|reporting|reports?|insights?|telemetry|monitoring)\b/i,
			/\b(dashboards?|admin panel|control panel)\b/i,
			/\b(charts?|graphs?|data ?viz|visuali[sz]ations?|time ?series)\b/i,
		],
		palette: "analytics-dashboard",
		style: "Information-dense but scannable — the UI recedes so the data reads. Chrome is quiet; every pixel earns its place.",
		typography:
			"'Archivo', system-ui, sans-serif; figures in 'JetBrains Mono', ui-monospace, monospace with `font-variant-numeric: tabular-nums`. Scale: h1 24px/700/-0.01em · h2 18px/600 · body 14px/400/1.5 · label 12px/700 uppercase 0.05em.",
		geometry:
			"Radius: 8px cards / 12px panels. Shadow: 0 1px 3px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.06). Spacing: 4px base, compact (12–16px card padding).",
		extra: "Categorical chart series, in this order: oklch(0.62 0.15 225) · oklch(0.60 0.14 300) · oklch(0.70 0.14 70) · oklch(0.62 0.13 150) · oklch(0.60 0.17 25) · oklch(0.58 0.13 340). These are chart marks, not UI roles — never restyle a button with one.",
		layout: "Filter/toolbar rail, KPI summary row, then a responsive grid of charts and tables. Most-important metric top-left.",
	},
	{
		id: "ecommerce",
		name: "E-commerce Storefront",
		matchers: [
			/\b(e-?commerce|online store|storefront|shop(?:ping)?|marketplace|retail|boutique|dropship\w*)\b/i,
			/\b(cart|checkout|catalog(?:ue)?|products?|inventory|orders?|sku)\b/i,
		],
		palette: "ecommerce",
		style: "Product-forward and inviting — imagery leads, the path to purchase is obvious and frictionless.",
		typography:
			"Display 'Bricolage Grotesque', system-ui, sans-serif; body 'Karla', system-ui, sans-serif. Scale: h1 34px/700/-0.02em · product-title 16px/600 · price 22px/700 tabular-nums · body 15px/400/1.6. Prices are unambiguous and prominent.",
		geometry:
			"Radius: 12px cards / 18px imagery (inviting). Shadow: card 0 1px 2px rgba(0,0,0,.06), 0 10px 20px rgba(0,0,0,.05); hover lift translateY(-2px). Spacing: 4px base.",
		extra: "--danger doubles as the sale/markdown color. Neutral surfaces are deliberate — the product photography is meant to carry the color, so do not tint the page to compete with it.",
		layout: "Hero/featured collection → product grid with consistent aspect ratios → PDP with gallery, price, one dominant CTA. Persistent cart access.",
	},
	{
		id: "developer-tool",
		name: "Developer Tool",
		matchers: [
			/\b(developer|dev ?tool|devtool\w*|programming|open ?source)\b/i,
			/\b(api|sdk|cli|terminal|ide|debugger|compiler|framework|library|documentation|docs)\b/i,
			/\b(git|deploy\w*|ci\/?cd|devops|pipeline|webhook)\b/i,
		],
		palette: "developer-tool",
		style: "Efficient, precise, honest — built for people who read carefully. Density is a feature; code is first-class.",
		typography:
			"Prose 'Geist', system-ui, sans-serif; code 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace. Scale: h1 26px/700 · body 15px/400/1.6 · code 13.5px/1.6.",
		geometry:
			"Radius: 6px controls / 8px blocks. Shadow: minimal — rely on a 1px --border edge (inset 0 0 0 1px). Spacing: 4px base; generous line-height in code blocks; a copy button on every snippet.",
		layout: "Docs-style: left nav, readable center column with runnable code blocks, right on-this-page rail.",
	},
	{
		id: "health-wellness",
		name: "Health & Wellness",
		matchers: [
			/\b(health|wellness|fitness|workout|exercise|gym|nutrition|diet|calorie)\b/i,
			/\b(meditation|mindful\w*|therapy|mental ?health|sleep|habit|self-?care|yoga)\b/i,
			/\b(medical|clinic|patient|doctor|telehealth|symptom)\b/i,
		],
		palette: "health-wellness",
		style: "Calm, encouraging, uncluttered — reduces anxiety, celebrates small wins, never overwhelms. Breathing room is the point.",
		typography:
			"Display 'Fraunces', Georgia, serif (soft and human, not corporate); body 'Nunito Sans', system-ui, sans-serif. Scale: h1 32px/600 · h2 22px/600 · body 16px/400/1.7 (airy). Supportive microcopy, not commanding.",
		geometry:
			"Radius: 16px cards / 24px feature blocks (soft). Shadow: gentle 0 4px 16px rgba(0,0,0,.06). Spacing: 8px base, generous (8/16/24/32/48).",
		extra: "--warn is the gentle celebratory highlight here (a streak, a milestone) as well as its caution role — warmth, never alarm.",
		layout: "Today's focus / progress first, then guided actions as calm cards, then history. Plenty of whitespace; one clear next step.",
	},
	{
		id: "creative-portfolio",
		name: "Creative Portfolio",
		matchers: [
			/\b(portfolio|showcase|gallery|lookbook)\b/i,
			/\b(photographer|photography|designer|illustrator|artist|creative|freelancer|resume|personal site)\b/i,
			/\b(agency|studio)\b/i,
		],
		palette: "creative-portfolio",
		style: "Expressive and editorial — the work is the hero, the UI a quiet frame. Room for a distinct point of view.",
		typography:
			"Display 'Instrument Serif', Georgia, serif; body 'Space Grotesk', system-ui, sans-serif. Scale: h1 clamp(44px,7vw,88px)/400/-0.02em · body 16px/400/1.6. The size contrast between display and caption is the whole effect — make it dramatic.",
		geometry:
			"Radius: 2px / 4px (sharp, editorial). Shadow: none — depth comes from scale and whitespace. Spacing: large margins, let images breathe.",
		extra: "The neutrals carry zero chroma on purpose so the work supplies all the color. --accent is a punctuation mark — one or two uses per page, never a theme.",
		layout: "Full-bleed hero → asymmetric/masonry grid of work → generous margins → clear contact/about close.",
	},
	{
		id: "saas-product",
		name: "SaaS Product",
		matchers: [
			/\bsaas\b/i,
			/\b(subscription|onboarding|workspace|multi-?tenant|b2b)\b/i,
			/\b(crm|project management|task manager|team collaboration|productivity|admin dashboard)\b/i,
		],
		palette: "saas-product",
		style: "Professional, structured, confidence-inspiring — approachable at first-run, deep enough for daily power use.",
		typography:
			"'Plus Jakarta Sans', system-ui, sans-serif; data and IDs in 'JetBrains Mono', ui-monospace, monospace with tabular-nums. Scale: h1 30px/800/-0.02em · h2 20px/700 · body 15px/400/1.6 · label 13px/600.",
		geometry:
			"Radius: 8px controls / 12px cards. Shadow: 0 1px 2px rgba(16,24,40,.06), 0 4px 12px rgba(16,24,40,.06). Spacing: 4px base.",
		extra: "The amber --accent is LIGHT, so --accent-contrast is ink, not white. Never hard-code white text on the brand fill here; use the token and it stays readable.",
		layout: "Persistent nav (side or top), a focused primary work area, one clear primary action per screen. Designed empty and loading states.",
	},
	{
		id: "marketing-landing",
		name: "Marketing Landing Page",
		matchers: [
			/\b(landing page|landing|marketing|campaign|promo\w*)\b/i,
			/\b(launch|waitlist|coming soon|newsletter|lead ?gen|conversion|signup|sign up)\b/i,
			/\b(startup|product page|hero section)\b/i,
		],
		palette: "marketing-landing",
		style: "Persuasive and momentum-building — one clear narrative that guides the eye straight to a single conversion goal.",
		typography:
			"Display 'Sora', system-ui, sans-serif; body 'Manrope', system-ui, sans-serif. Scale: h1 clamp(40px,6vw,72px)/800/-0.03em · sub 18px/400/1.6 · body 17px/400/1.6 · CTA 16px/600. Big benefit-led headlines, skimmable body.",
		geometry:
			"Radius: 10px cards / 999px pill CTAs. Shadow: CTA 0 8px 24px color-mix(in oklch, var(--accent) 30%, transparent). Spacing: 4px base; generous 80–96px section padding.",
		extra: "A dark band is welcome for one section: use --text as its background and --bg as its text. Flat and deliberate — never a gradient, and never more than one such band.",
		layout: "Hero (headline + sub + primary CTA) → proof/benefits → features → testimonial/logos → repeated CTA. One dominant action throughout.",
	},
];
