---
name: website-builder
description: "Visual-first workflow for building business websites, landing pages, and one-pagers from real source material (Instagram, existing site, attached photos, menu PDF). Enforces asset extraction, image discipline, and a screenshot-and-critique gate. Use whenever the user wants a site built — especially small business / restaurant / portfolio."
risk: low
category: Frontend
tags: [website, landing-page, frontend, business, restaurant, instagram, photos]
triggers:
  - build a website
  - build me a site
  - landing page
  - business site
  - one-pager
  - restaurant menu site
  - portfolio site
  - from this instagram
  - from this menu
allowed-tools: [extract_site_assets, browser, web_fetch, view_image, read, write, edit, bash, build_app]
---

# Website Builder

A visual-first protocol for shipping business websites that don't look like a wall of text. Handles the cases that default LLM frontends fail at: real photos missing, images sized wrong, hero is a color block, mobile collapse is broken.

## When to use

Trigger this when the user asks to build:
- A small business / restaurant / store landing page
- A portfolio or one-pager
- A site "from this Instagram" / "from this menu" / "from these photos"
- Anything where they handed you source material and expect to see it on the page

If they just want a generic component or admin dashboard, skip this skill and use the standard `app-builder` flow.

## Hard rules

These are non-negotiable. If you skip any, the output will look like the text-wall mistake we are trying to avoid.

### 1. Assets first, HTML second

Real images go in the build before you write a single tag. There is no version of this skill where you start with HTML.

- **User attached photos in chat** → copy each one to `<app>/assets/` via `bash cp` (the file path is given to you in the user message under `[Attached file paths on disk]`). Never regenerate. Never substitute. Never ignore.
- **User gave a source URL** → run `extract_site_assets` against it. Save into `<app>/assets/`.
- **JS-rendered page (Instagram profile, single-page apps)** → `extract_site_assets` will return few or zero hits. Fall back to the `browser` tool: `navigate` then `evaluate` `Array.from(document.images).map(i => i.src)`, then download each via `web_fetch` or pass the URL list back to `extract_site_assets`.
- **Multiple sources** → extract from each one in turn before building.
- **No source given** → ask the user once for photos or an Instagram handle. Do not invent a "stock-photo placeholder" version.

### 2. No text walls

A section with more than ~60 words of body copy and no visual is broken. Every section needs a visual anchor.

- Hero = real image (or bold typography on a CSS gradient — never a flat color block) + headline + sub + CTA.
- Body sections = photo + headline + short paragraph, OR cards in a grid, OR icon list. Not paragraph stacks.
- "Menu" sections = card grid with item photo, name, description, price.

### 3. Image discipline

Every `<img>` gets:
- Explicit `width` and `height` attributes (or CSS `aspect-ratio`)
- `object-fit: cover` so portrait/landscape mixes don't blow up the layout
- `loading="lazy"` (except hero)
- `max-width: 100%` in the global CSS

Hero image caps at `80vh`. Photo grids use a fixed `aspect-ratio` per cell. Never let a 4000×3000 photo render at native size.

### 4. Mobile-first

Mobile breakpoint is the default layout. Desktop is the enhancement layer with `@media (min-width: ...)`. Use `clamp()` for fluid type. Use CSS grid/flex for everything.

### 5. Visual hierarchy

Standard order for a small-business one-pager:
1. Hero (image + name + tagline + primary CTA)
2. Social proof OR photo grid
3. About (short, with a face if possible)
4. Menu / services (card grid)
5. Hours + location (with map embed if address known)
6. Contact / final CTA + footer

### 6. Screenshot-and-critique gate

After the first build hits disk, take a screenshot and grade your own work before reporting done.

```
1. browser({ action: "navigate", url: <local file or app URL> })
2. browser({ action: "screenshot" })
3. view_image({ ... }) and answer this checklist:
   - Is there a real hero image (not a color block)?
   - Are all images sized — none rendering huge?
   - Does any section have a wall of text without a visual?
   - Does the layout collapse cleanly at mobile width?
   - Are real photos from the source visible (no placeholder.com, no lorem)?
4. Iterate at least once based on what you see.
```

This gate is the single biggest difference between "looks like a real site" and "looks like an LLM wrote it."

## Workflow

```
1. Detect source material in the user message:
   - Attached photos? → record file paths
   - Instagram handle / URL? → record URL
   - Existing site URL? → record URL
   - Menu PDF? → record path

2. Pre-build asset extraction:
   - bash mkdir -p workspace/apps/<name>/assets
   - For each attached photo: bash cp <attached path> workspace/apps/<name>/assets/
   - For each URL: extract_site_assets({ url, output_dir: "workspace/apps/<name>/assets" })
   - For Instagram or other JS-heavy sites: browser navigate + evaluate to grab src URLs, then web_fetch each into assets/

3. Pick a template based on the request shape:
   - Restaurant / cafe / bar → hero photo + menu card grid + hours + map
   - Small store (NutriShop pattern) → hero + product grid + about + contact
   - Portfolio → hero + project grid + bio + contact
   - One-pager → hero + 3-section pitch + CTA

4. Write index.html (single file is fine) following the rules above.
   - All assets reference relative paths under assets/
   - Inline CSS in <style>, mobile-first
   - Light mode by default

5. Screenshot-and-critique gate (see rule #6). Iterate.

6. Write PROJECT.md with what was built, what assets came from where, and any gaps the user should fill (missing hours, etc.).

7. Report APP_READY: <url>.
```

## Anti-patterns

Do not do these. Each one is a real failure mode we have seen.

- ❌ Starting with HTML before extracting assets
- ❌ Using `placeholder.com`, `lorem-picsum`, `unsplash random`, or any stock CDN as a stand-in
- ❌ Ignoring an attached photo because the chat-attached version "is enough" — it isn't, you need the bytes on disk
- ❌ Letting images render at native resolution
- ❌ A hero that is just a `linear-gradient` flat color with no photo and no bold typography
- ❌ Sections that are `<h2>` + 3× `<p>` with no visual
- ❌ Reporting done without taking a screenshot

## Notes

- This skill covers the build. It does not cover deploy, domain wiring, or analytics — those are separate flows.
- For larger multi-page sites, switch to `app-builder` with the `nextjs-static` template after the one-pager is shipped.
- Light mode is the default. Only switch to dark if the source brand is clearly dark.
