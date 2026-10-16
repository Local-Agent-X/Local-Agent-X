# Bundled design-system faces

The typefaces the design system names (`src/tools/design-systems.ts`), so apps
can load them without a font CDN. Each face is a latin subset from
[Fontsource](https://fontsource.org) 5.3.0, licensed under the SIL Open Font
License 1.1; its license is `<slug>/OFL.txt`.

- `<slug>.css` declares the face under the exact name the design system quotes.
- Apps load it from their own origin: `<link rel="stylesheet" href="/vendor/fonts/<slug>.css">`
  (served by `src/server/agent-origin.ts` through `resolveBundledFontFile` in
  `src/server/app-serving-policy.ts`).
- The table of faces is `BUNDLED_FONTS` in `src/tools/design-fonts.ts`.
  `src/tools/design-fonts.test.ts` fails if a named face, its file or its
  license is missing, or if a file here is not in the table.

To add a face: `npm pack @fontsource-variable/<name>` (or `@fontsource/<name>`
for a static face) in a scratch folder, copy `files/<name>-latin-wght-normal.woff2`
and `LICENSE` (as `OFL.txt`) into `<slug>/`, write `<slug>.css`, and add the row
to `BUNDLED_FONTS`.
