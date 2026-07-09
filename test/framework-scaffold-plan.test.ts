/**
 * The harness-owned scaffold plan + ownership predicate (pure), and the
 * runFrameworkScaffold short-circuits that must NOT spawn npm (a non-owned
 * framework, and an already-scaffolded dir on retry/update).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  harnessOwnsScaffold,
  viteScaffoldPlan,
  SCAFFOLD_MANIFEST_REL,
} from "../src/tools/framework-scaffold.js";
import { runFrameworkScaffold } from "../src/tools/framework-scaffold-run.js";

describe("harnessOwnsScaffold", () => {
  it("owns the frontend-spa default (vite / unknown / static)", () => {
    expect(harnessOwnsScaffold("vite")).toBe(true);
    expect(harnessOwnsScaffold("unknown")).toBe(true);
    expect(harnessOwnsScaffold("static")).toBe(true);
  });
  it("leaves named metaframeworks on the advised-creator path", () => {
    for (const f of ["nextjs", "nuxt", "sveltekit", "astro", "remix"] as const) {
      expect(harnessOwnsScaffold(f)).toBe(false);
    }
  });
});

describe("viteScaffoldPlan", () => {
  it("bakes the /apps/<id>/ base path into the owned vite.config", () => {
    const plan = viteScaffoldPlan("recipe-box");
    const cfg = plan.files.find((f) => f.path === "vite.config.ts");
    expect(cfg?.content).toContain("base: '/apps/recipe-box/'");
    expect(cfg?.content).toContain("@tailwindcss/vite");
    expect(cfg?.content).toContain("LAX_DEV_PORT");
  });
  it("imports Tailwind v4 in src/index.css", () => {
    const css = viteScaffoldPlan("x").files.find((f) => f.path === "src/index.css");
    expect(css?.content).toContain('@import "tailwindcss"');
  });
  it("owns package.json + config, not src/", () => {
    const owned = viteScaffoldPlan("x").manifest.ownedPaths;
    expect(owned).toContain("package.json");
    expect(owned).toContain("vite.config.ts");
    expect(owned).toContain("tsconfig.json");
    expect(owned.some((p) => p.startsWith("src/"))).toBe(false);
  });
});

describe("runFrameworkScaffold — short-circuits (never spawns npm)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "scaffold-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("is a no-op for a non-owned framework", async () => {
    const r = await runFrameworkScaffold(dir, "app", "nextjs");
    expect(r.scaffolded).toBe(false);
    expect(existsSync(join(dir, SCAFFOLD_MANIFEST_REL))).toBe(false);
  });

  it("is idempotent when a scaffold already exists (retry/update)", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    const r = await runFrameworkScaffold(dir, "app", "vite");
    expect(r.scaffolded).toBe(true);
    // Did NOT overwrite / re-run: no manifest was written this pass.
    expect(existsSync(join(dir, SCAFFOLD_MANIFEST_REL))).toBe(false);
  });
});
