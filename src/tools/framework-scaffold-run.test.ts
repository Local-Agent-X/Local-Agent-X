// refreshOwnedViteConfig regression: already-scaffolded apps must converge to
// the current canonical vite.config when the template evolves (the merchhelm
// case: its config predated the /api/connectors dev proxy, so the app opened
// on the dev origin could never reach its connectors — vite 404'd the calls).
// Ownership is proven by the scaffold manifest; anything else is untouchable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { refreshOwnedViteConfig } from "./framework-scaffold-run.js";
import { viteConfigText, viteScaffoldPlan, SCAFFOLD_MANIFEST_REL } from "./framework-scaffold.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-scaffold-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeManifest(framework = "vite", ownedPaths = ["vite.config.ts"]): void {
  const p = join(dir, SCAFFOLD_MANIFEST_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ framework, ownedPaths }), "utf-8");
}

describe("refreshOwnedViteConfig", () => {
  it("rewrites a stale harness-owned config to the current template", () => {
    writeManifest();
    writeFileSync(join(dir, "vite.config.ts"), "// old template without the connector proxy\n", "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(true);
    expect(readFileSync(join(dir, "vite.config.ts"), "utf-8")).toBe(viteConfigText("myapp"));
  });

  it("no-ops when the config already matches (idempotent across restarts)", () => {
    writeManifest();
    writeFileSync(join(dir, "vite.config.ts"), viteConfigText("myapp"), "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
  });

  it("never touches an app without a scaffold manifest (ownership unproven)", () => {
    const handAuthored = "// the user's own vite config\n";
    writeFileSync(join(dir, "vite.config.ts"), handAuthored, "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
    expect(readFileSync(join(dir, "vite.config.ts"), "utf-8")).toBe(handAuthored);
  });

  it("never touches a non-vite or non-owning manifest", () => {
    writeManifest("nextjs");
    writeFileSync(join(dir, "vite.config.ts"), "// stray\n", "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);

    writeManifest("vite", ["package.json"]);   // vite but config not owned
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
  });

  it("returns false when there is no vite.config.ts to refresh", () => {
    writeManifest();
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
  });
});

describe("viteConfigText — the canonical template's load-bearing pieces", () => {
  const text = viteConfigText("myapp");

  it("keeps the proxy base and env-driven HMR port", () => {
    expect(text).toContain("base: '/apps/myapp/'");
    expect(text).toContain("LAX_DEV_PORT");
    expect(text).toContain("strictPort: true");
  });

  it("forwards /api/connectors to LAX with the scoped capability (direct-origin apps)", () => {
    expect(text).toContain("'/api/connectors'");
    expect(text).toContain("LAX_SERVER_PORT");
    expect(text).toContain("LAX_CONNECTOR_TOKEN");
    expect(text).toMatch(/authorization.*Bearer/);
  });

  it("is exactly what the scaffold plan writes (one template, no fork)", () => {
    const planned = viteScaffoldPlan("myapp").files.find((f) => f.path === "vite.config.ts");
    expect(planned?.content).toBe(text);
  });
});
