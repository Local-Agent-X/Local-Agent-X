/**
 * Framework-hybrid rejection + framework-aware scaffold recipe — the fix for a
 * build that shipped a Next app carrying a dead Vite config and rendered a black
 * page. Two surfaces:
 *   - scanAppForFrameworkHybrid: a Next app + a SERVING vite.config is rejected;
 *     a Next app + a vitest-only vite.config (legit) is NOT.
 *   - frontendScaffoldRecipeLines: a Next brief gets the Next basePath recipe, a
 *     metaframework brief gets its own base-path key, and an unspecified brief
 *     defaults to the Vite recipe — never the wrong framework's config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAppForFrameworkHybrid, formatFrameworkHybrid } from "./app-build-verify.js";
import { frontendScaffoldRecipeLines } from "./render-builder-prompt.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-hybrid-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function pkg(o: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(o));
}

describe("scanAppForFrameworkHybrid", () => {
  it("flags a Next dep + a vite.config that configures serving (base/server) — the black-page hybrid", () => {
    pkg({ dependencies: { next: "latest", vite: "latest", react: "latest" } });
    writeFileSync(join(dir, "next.config.js"), "export default { basePath: '/apps/x' };");
    writeFileSync(join(dir, "vite.config.js"), "export default { base: '/apps/x/', server: { port: 5178 } };");
    const r = scanAppForFrameworkHybrid(dir);
    expect(r.hybrid).toBe(true);
    expect(r.reason).toContain("Next.js");
    expect(r.reason).toContain("vite.config.js");
    expect(formatFrameworkHybrid(r.reason)).toContain("Pick exactly one framework");
  });

  it("flags it from a next.config even with no explicit next dep", () => {
    pkg({ dependencies: { react: "latest" } });
    writeFileSync(join(dir, "next.config.mjs"), "export default {};");
    writeFileSync(join(dir, "vite.config.js"), "export default { server: { host: true } };");
    expect(scanAppForFrameworkHybrid(dir).hybrid).toBe(true);
  });

  it("does NOT flag a Next app whose vite.config is vitest-only (no base/server key)", () => {
    pkg({ dependencies: { next: "latest" }, devDependencies: { vitest: "latest" } });
    writeFileSync(join(dir, "next.config.js"), "export default {};");
    writeFileSync(join(dir, "vite.config.js"), "export default { test: { environment: 'jsdom' } };");
    expect(scanAppForFrameworkHybrid(dir).hybrid).toBe(false);
  });

  it("does NOT flag a pure Vite app (no Next signal at all)", () => {
    pkg({ devDependencies: { vite: "latest" } });
    writeFileSync(join(dir, "vite.config.js"), "export default { base: '/apps/x/', server: { port: 5178 } };");
    expect(scanAppForFrameworkHybrid(dir).hybrid).toBe(false);
  });

  it("does NOT flag a pure Next app (no vite.config)", () => {
    pkg({ dependencies: { next: "latest" } });
    writeFileSync(join(dir, "next.config.js"), "export default { basePath: '/apps/x' };");
    expect(scanAppForFrameworkHybrid(dir).hybrid).toBe(false);
  });

  it("no package.json → not a hybrid (nothing scaffolded to conflict)", () => {
    expect(scanAppForFrameworkHybrid(dir).hybrid).toBe(false);
  });
});

describe("frontendScaffoldRecipeLines — framework-aware, never both", () => {
  it("nextjs → Next basePath/assetPrefix recipe, not the Vite serve config", () => {
    const lines = frontendScaffoldRecipeLines("recipe-box", "nextjs").join("\n");
    expect(lines).toContain("basePath: '/apps/recipe-box'");
    expect(lines).toContain("assetPrefix: '/apps/recipe-box'");
    // The Vite `base:`/`server:` serve snippet must NOT be taught for a Next app —
    // that leak is what created the hybrid. (Prose telling it to AVOID a
    // vite.config is fine and expected.)
    expect(lines).not.toContain("base: '/apps/recipe-box/'");
    expect(lines).toContain("do NOT add a vite.config");
    expect(lines).toContain("EXACTLY ONE framework");
  });

  it("unknown (no framework named) → defaults to the Vite recipe, not Next", () => {
    const lines = frontendScaffoldRecipeLines("recipe-box", "unknown").join("\n");
    expect(lines).toContain("base: '/apps/recipe-box/'");
    expect(lines).toContain("hmr: { clientPort:");
    expect(lines).not.toContain("basePath");
    expect(lines).toContain("EXACTLY ONE framework");
  });

  it("vite (named) → the Vite recipe", () => {
    const lines = frontendScaffoldRecipeLines("recipe-box", "vite").join("\n");
    expect(lines).toContain("Vite + React");
    expect(lines).not.toContain("basePath");
  });

  // A named metaframework must get ITS OWN base-path key, never the Vite recipe
  // — the bug the else-branch used to have (a Nuxt request told to write Vite).
  it("nuxt → Nuxt's own baseURL, not the Vite base/hmr snippet", () => {
    const lines = frontendScaffoldRecipeLines("recipe-box", "nuxt").join("\n");
    expect(lines).toContain("Nuxt");
    expect(lines).toContain("app.baseURL");
    expect(lines).not.toContain("hmr: { clientPort:");
    expect(lines).not.toContain("Vite + React");
    expect(lines).toContain("EXACTLY ONE framework");
  });

  it("sveltekit → kit.paths.base (no trailing slash), astro → base", () => {
    const svelte = frontendScaffoldRecipeLines("recipe-box", "sveltekit").join("\n");
    expect(svelte).toContain("kit.paths.base: '/apps/recipe-box'");
    const astro = frontendScaffoldRecipeLines("recipe-box", "astro").join("\n");
    expect(astro).toContain("Astro");
  });

  // The creator-first contract: every recipe hands the agent the framework's
  // OFFICIAL non-interactive creator, never an instruction to hand-write the
  // skeleton (the source of stale versions + the bg-white / hybrid failures).
  it("each framework emits its official non-interactive creator command", () => {
    expect(frontendScaffoldRecipeLines("x", "vite").join("\n")).toContain("npm create vite@latest . -- --template react-ts");
    expect(frontendScaffoldRecipeLines("x", "unknown").join("\n")).toContain("npm create vite@latest .");
    expect(frontendScaffoldRecipeLines("x", "nextjs").join("\n")).toContain("npx create-next-app@latest .");
    expect(frontendScaffoldRecipeLines("x", "nuxt").join("\n")).toContain("npx nuxi@latest init .");
    expect(frontendScaffoldRecipeLines("x", "sveltekit").join("\n")).toContain("npx sv create .");
    expect(frontendScaffoldRecipeLines("x", "astro").join("\n")).toContain("npm create astro@latest .");
  });

  it("never tells the agent to hand-author the skeleton files", () => {
    for (const fw of ["vite", "unknown", "nextjs", "nuxt", "sveltekit", "astro"] as const) {
      const lines = frontendScaffoldRecipeLines("x", fw).join("\n");
      expect(lines).toContain("do NOT hand-write");
      // No recipe should enumerate a hand-written package.json dep list anymore.
      expect(lines).not.toContain("package.json (vite, @vitejs/plugin-react");
    }
  });
});
