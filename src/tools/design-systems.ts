/**
 * Design-system data — one EXACT, committed token set per archetype.
 *
 * These are the values the builder must implement verbatim: a full palette (not
 * one "example" hex), an exact font stack + type scale with weights and
 * letter-spacing, and exact radius/shadow/spacing. Vague mood prose ("a modern
 * sans", "navy or slate") produces generic output because a model with no visual
 * taste of its own fills the gaps with slop; exact tokens give it a real system
 * to execute. Every value here is original — a coherent palette authored for the
 * archetype, not lifted from any product's identity.
 *
 * Fonts lead with a named webface but always fall back to a system stack, so the
 * design holds even where an external font can't load (the static preview blocks
 * external CDNs). The builder self-hosts the named face on the framework path or
 * renders the system fallback — either way the scale/weights/color carry the look.
 *
 * Data only. The classifier + renderer live in design-brief.ts.
 */
import type { DesignArchetype } from "./design-brief.js";

export const NEUTRAL_ARCHETYPE: DesignArchetype = {
	id: "modern-web-app",
	name: "Modern Web App",
	matchers: [],
	style: "Clean, contemporary, content-first — polish through restraint, one clear center of gravity per view.",
	tokens: [
		"Palette (exact CSS variables): --bg #ffffff · --muted-bg #f8fafc · --surface #ffffff · --text #111827 · --text-muted #6b7280 · --border #e5e7eb · --accent #2563eb · --accent-hover #1d4ed8",
		"Typography: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif. Scale: h1 28px/700/-0.02em · h2 20px/600/-0.01em · body 16px/400/1.6 · label 13px/500. Self-host Inter or fall back to system-ui.",
		"Radius: 8px controls / 12px cards. Shadow: 0 1px 2px rgba(0,0,0,.06), 0 6px 16px rgba(0,0,0,.05). Spacing: 4px base (4/8/12/16/24/32/48).",
	].join("\n"),
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
		style: "Precise, calm, trustworthy — accuracy communicated through alignment and generous spacing. Numbers are first-class citizens.",
		tokens: [
			"Palette (exact): --bg #0b1220 · --surface #111a2e · --elevated #17223c · --text #e8edf5 · --text-muted #8b98b0 · --border rgba(255,255,255,.08) · --accent #3b82f6 · --accent-hover #60a5fa · --gain #10b981 · --loss #ef4444 (gain/loss are SEMANTIC only, never decoration)",
			"Typography: 'Inter', system-ui, -apple-system, sans-serif. Scale: h1 32px/700/-0.02em · h2 22px/600/-0.01em · body 15px/400/1.5 · caption 13px/500. Money & metrics: ui-monospace, tabular-nums so columns align.",
			"Radius: 6px controls / 10px cards / 14px panels. Shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3). Spacing: 4px base.",
		].join("\n"),
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
		style: "Information-dense but scannable — the UI recedes so the data reads. Chrome is quiet; every pixel earns its place.",
		tokens: [
			"Palette (exact): --bg #f6f8fb · --surface #ffffff · --text #0f172a · --text-muted #64748b · --border #e2e8f0 · --accent #0ea5e9 · --accent-hover #0284c7. Categorical series (in order): #0ea5e9 #8b5cf6 #f59e0b #10b981 #ef4444 #ec4899.",
			"Typography: 'Inter', system-ui, sans-serif. Scale: h1 24px/700/-0.01em · h2 18px/600 · body 14px/400/1.5 · label 12px/600 uppercase 0.04em. Grids use tabular-nums.",
			"Radius: 8px cards / 12px panels. Shadow: 0 1px 3px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.06). Spacing: 4px base, compact (12–16px card padding).",
		].join("\n"),
		layout: "Filter/toolbar rail, KPI summary row, then a responsive grid of charts and tables. Most-important metric top-left.",
	},
	{
		id: "ecommerce",
		name: "E-commerce Storefront",
		matchers: [
			/\b(e-?commerce|online store|storefront|shop(?:ping)?|marketplace|retail|boutique|dropship\w*)\b/i,
			/\b(cart|checkout|catalog(?:ue)?|products?|inventory|orders?|sku)\b/i,
		],
		style: "Product-forward and inviting — imagery leads, the path to purchase is obvious and frictionless.",
		tokens: [
			"Palette (exact): --bg #faf9f7 · --surface #ffffff · --text #1c1917 · --text-muted #78716c · --border #e7e5e4 · --accent #16a34a · --accent-hover #15803d · --sale #dc2626. Neutral surfaces so product imagery carries the color.",
			"Typography: 'Inter', system-ui, sans-serif. Scale: h1 30px/700/-0.02em · product-title 16px/600 · price 22px/700 · body 15px/400/1.6. Prices are unambiguous and prominent.",
			"Radius: 12px cards / 18px imagery (inviting). Shadow: card 0 1px 2px rgba(0,0,0,.06), 0 10px 20px rgba(0,0,0,.05); hover lift translateY(-2px). Spacing: 4px base.",
		].join("\n"),
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
		style: "Efficient, precise, honest — built for people who read carefully. Density is a feature; code is first-class.",
		tokens: [
			"Palette (exact): --bg #0d1117 · --surface #161b22 · --elevated #1c2129 · --text #e6edf3 · --text-muted #7d8590 · --border #30363d · --accent #22d3ee · --accent-hover #67e8f9.",
			"Typography: prose 'Inter', system-ui, sans-serif; code 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace. Scale: h1 26px/700 · body 15px/400/1.6 · code 13.5px/1.6.",
			"Radius: 6px controls / 8px blocks. Shadow: minimal — rely on 1px --border (inset 0 0 0 1px). Spacing: 4px base; generous line-height in code blocks; copy button on every snippet.",
		].join("\n"),
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
		style: "Calm, encouraging, uncluttered — reduces anxiety, celebrates small wins, never overwhelms. Breathing room is the point.",
		tokens: [
			"Palette (exact): --bg #f5faf7 · --surface #ffffff · --text #1f2d27 · --text-muted #6b7d74 · --border #dce8e1 · --accent #34d399 · --accent-hover #10b981 · --warm #fcd34d (gentle celebratory highlight). Low-saturation, easy on the eye.",
			"Typography: 'Nunito', 'Inter', system-ui, sans-serif (rounded, friendly). Scale: h1 30px/700 · h2 22px/600 · body 16px/400/1.7 (airy). Supportive microcopy, not commanding.",
			"Radius: 16px cards / 24px feature blocks (soft). Shadow: gentle 0 4px 16px rgba(52,211,153,.12). Spacing: 8px base, generous (8/16/24/32/48).",
		].join("\n"),
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
		style: "Expressive and editorial — the work is the hero, the UI a quiet frame. Room for a distinct point of view.",
		tokens: [
			"Palette (exact): --bg #0a0a0a · --surface #141414 · --text #fafafa · --text-muted #a3a3a3 · --border rgba(255,255,255,.1) · --accent #f43f5e (used sparingly). Mostly monochrome so the work carries the color.",
			"Typography: display 'Fraunces', Georgia, serif for statements; body 'Inter', system-ui, sans-serif. Scale: h1 clamp(40px,7vw,84px)/600/-0.03em · body 16px/400/1.6. Dramatic size contrast display↔caption.",
			"Radius: 2px / 4px (sharp, editorial). Shadow: none — depth comes from scale and whitespace. Spacing: large margins, let images breathe.",
		].join("\n"),
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
		style: "Professional, structured, confidence-inspiring — approachable at first-run, deep enough for daily power use.",
		tokens: [
			"Palette (exact): --bg #ffffff · --muted-bg #f8fafc · --surface #ffffff · --text #0f172a · --text-muted #64748b · --border #e2e8f0 · --accent #6366f1 · --accent-hover #4f46e5 · --success #16a34a · --warn #f59e0b · --error #dc2626 (flat brand, never a gradient).",
			"Typography: 'Inter', system-ui, sans-serif. Scale: h1 30px/700/-0.02em · h2 20px/600 · body 15px/400/1.6 · label 13px/500. Clear labels, helpful empty states, unambiguous button text.",
			"Radius: 8px controls / 12px cards. Shadow: 0 1px 2px rgba(16,24,40,.06), 0 4px 12px rgba(16,24,40,.06). Spacing: 4px base.",
		].join("\n"),
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
		style: "Persuasive and momentum-building — one clear narrative that guides the eye straight to a single conversion goal.",
		tokens: [
			"Palette (exact): --bg #ffffff · --ink #0f0f1a · --text #18181b · --text-muted #52525b · --border #e4e4e7 · --accent #7c3aed · --accent-hover #6d28d9. Dark hero sections use --ink bg with #fafafa text (flat, never a purple→pink gradient).",
			"Typography: 'Sora', 'Inter', system-ui, sans-serif. Scale: h1 clamp(40px,6vw,72px)/800/-0.03em · sub 18px/400/1.6 · body 17px/400/1.6 · CTA 16px/600. Big benefit-led headlines, skimmable body.",
			"Radius: 10px cards / 999px pill CTAs. Shadow: CTA 0 8px 24px rgba(124,58,237,.3). Spacing: 4px base; generous 80–96px section padding.",
		].join("\n"),
		layout: "Hero (headline + sub + primary CTA) → proof/benefits → features → testimonial/logos → repeated CTA. One dominant action throughout.",
	},
];
