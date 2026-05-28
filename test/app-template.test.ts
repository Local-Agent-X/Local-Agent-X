/**
 * seedAppTemplate — guards Tier 1.B of the app-builder hardening pass:
 * pre-seed a working index.html + AGENTS.md into a fresh app dir so weak
 * models edit a known-good starter instead of generating from scratch.
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAppTemplate } from "../src/tools/app-tools/app-template.js";

const createdDirs: string[] = [];

function makeFreshDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lax-app-template-${label}-`));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of createdDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe("seedAppTemplate", () => {
  it("writes index.html + AGENTS.md into a fresh app dir", () => {
    const dir = makeFreshDir("fresh");
    const result = seedAppTemplate(dir, "my-cool-app");

    expect(result.written.sort()).toEqual(["AGENTS.md", "index.html"]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("is idempotent — re-running preserves existing files (no clobber)", () => {
    const dir = makeFreshDir("idem");
    mkdirSync(dir, { recursive: true });

    const customHtml = "<!doctype html><html><body>user edits</body></html>";
    const customAgents = "# user notes\n";
    writeFileSync(join(dir, "index.html"), customHtml, "utf-8");
    writeFileSync(join(dir, "AGENTS.md"), customAgents, "utf-8");

    const result = seedAppTemplate(dir, "anything");
    expect(result.written).toEqual([]);
    expect(result.skipped.sort()).toEqual(["AGENTS.md", "index.html"]);

    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe(customHtml);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe(customAgents);
  });

  it("partial idempotency — only seeds the file that's missing", () => {
    const dir = makeFreshDir("partial");
    const customAgents = "# my agents\n";
    writeFileSync(join(dir, "AGENTS.md"), customAgents, "utf-8");

    const result = seedAppTemplate(dir, "partial-app");
    expect(result.written).toEqual(["index.html"]);
    expect(result.skipped).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe(customAgents);
  });

  it("generated index.html parses sanely — has doctype, viewport, CSP meta, no external CDN URLs", () => {
    const dir = makeFreshDir("sanity");
    seedAppTemplate(dir, "shape-check");
    const html = readFileSync(join(dir, "index.html"), "utf-8");

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<html\b[^>]*>/i);
    expect(html).toMatch(/<\/html>\s*$/i);

    // Viewport meta present
    expect(html).toMatch(/<meta[^>]+name=["']viewport["'][^>]+>/i);

    // CSP meta present and explicitly self-only for script/style
    expect(html).toMatch(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+>/i);
    expect(html).toMatch(/script-src\s+'self'/);
    expect(html).toMatch(/style-src\s+'self'/);

    // No external CDN URLs anywhere — no https:// in src/href attrs
    const externalSrc = /\b(src|href)\s*=\s*["']https?:\/\//i;
    expect(externalSrc.test(html)).toBe(false);

    // App slot exists
    expect(html).toMatch(/id=["']app["']/);
  });

  it("humanizes the app slug into the <title>", () => {
    const dir = makeFreshDir("title");
    seedAppTemplate(dir, "my-cool-app");
    const html = readFileSync(join(dir, "index.html"), "utf-8");
    expect(html).toContain("<title>My Cool App</title>");
  });

  it("AGENTS.md is a factual env contract — CSP block + 'editing this folder' line", () => {
    const dir = makeFreshDir("agents");
    seedAppTemplate(dir, "rules-check");
    const md = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    // Header is the environment spec, not advice
    expect(md).toMatch(/^# Environment/);
    // CSP block, each directive on its own line
    expect(md).toContain("script-src 'self' 'unsafe-inline'");
    expect(md).toContain("style-src  'self' 'unsafe-inline'");
    expect(md).toContain("img-src    'self' data: https: blob:");
    expect(md).toContain("font-src   'self' data:");
    expect(md).toContain("connect-src 'self'");
    // The "editing this folder" line
    expect(md).toContain("You are editing this folder.");
    expect(md).toContain("index.html starter is already present");
    // No "please" / "do not" pep-talk framing
    expect(md.toLowerCase()).not.toContain("please");
    expect(md.toLowerCase()).not.toMatch(/^\s*do not\b/m);
  });
});
