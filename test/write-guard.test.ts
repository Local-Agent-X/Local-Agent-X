/**
 * Tier 1 patch — write-time enforcement guard. Pure text checks that
 * reject obvious environment-contract violations (CDN references, missing
 * viewport meta) at the write/edit tool boundary so the build agent learns
 * within the same turn rather than waiting for a downstream CSP refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppWrite, writeGuardRejectionMessage } from "../src/tools/app-tools/write-guard.js";

const BLOCKED_CDNS = [
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1" />';
const VIEWPORT_PAD = "x".repeat(300); // pad so length >= 200 so viewport check fires

function cleanHtml(extraBody = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
${VIEWPORT_META}
<title>app</title>
</head>
<body>${extraBody}${VIEWPORT_PAD}</body>
</html>`;
}

describe("write-guard — blocks CDN hostnames in app files", () => {
  for (const host of BLOCKED_CDNS) {
    it(`rejects ${host} referenced in workspace/apps/<id>/index.html`, () => {
      const content = cleanHtml(`<script src="https://${host}/foo.js"></script>`);
      const r = checkAppWrite("/abs/workspace/apps/demo/index.html", content);
      expect(r.allow).toBe(false);
      expect(r.reason).toContain(host);
    });
  }
});

describe("write-guard — viewport meta requirement on html files", () => {
  it("rejects html that lacks a viewport meta tag", () => {
    const content = `<!doctype html>
<html><head><title>x</title></head>
<body>${VIEWPORT_PAD}</body></html>`;
    const r = checkAppWrite("/abs/workspace/apps/demo/index.html", content);
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/viewport/i);
  });

  it("allows clean inline html with viewport + no CDN", () => {
    const r = checkAppWrite("/abs/workspace/apps/demo/index.html", cleanHtml());
    expect(r.allow).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

describe("write-guard — skips viewport check for non-html files", () => {
  it("allows .css without viewport meta", () => {
    const r = checkAppWrite(
      "/abs/workspace/apps/demo/styles.css",
      "body { background: white; }".repeat(50), // > 200 chars
    );
    expect(r.allow).toBe(true);
  });

  it("allows .js without viewport meta", () => {
    const r = checkAppWrite(
      "/abs/workspace/apps/demo/app.js",
      "console.log('ok');".repeat(50),
    );
    expect(r.allow).toBe(true);
  });
});

describe("write-guard — out-of-scope paths bypass guard entirely", () => {
  it("allows CDN ref outside workspace/apps/ (src/foo.ts is normal repo code)", () => {
    const content = `// fetch script from cdn.jsdelivr.net is fine in repo code`;
    const r = checkAppWrite("/abs/src/foo.ts", content);
    expect(r.allow).toBe(true);
  });

  it("allows html outside workspace/apps/ without viewport", () => {
    const r = checkAppWrite(
      "/abs/public/something.html",
      `<html><body>${VIEWPORT_PAD}</body></html>`,
    );
    expect(r.allow).toBe(true);
  });
});

describe("write-guard — tiny html snippets skip the viewport check", () => {
  it("allows a short html fragment (< 200 chars) without viewport meta", () => {
    const tiny = `<html><body><p>partial</p></body></html>`;
    expect(tiny.length).toBeLessThan(200);
    const r = checkAppWrite("/abs/workspace/apps/demo/index.html", tiny);
    expect(r.allow).toBe(true);
  });
});

describe("write-guard — Windows backslash paths are detected", () => {
  it("recognises workspace\\apps\\<id> as in-scope", () => {
    const content = cleanHtml(`<link href="https://fonts.googleapis.com/css?family=Inter" rel="stylesheet">`);
    const r = checkAppWrite("C:\\abs\\workspace\\apps\\demo\\index.html", content);
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("fonts.googleapis.com");
  });
});

describe("write-guard — harness-owned baseline lock (manifest-driven)", () => {
  // The lock keys off a per-app scaffold manifest, NOT a global filename rule,
  // so the two concerns (content policy vs baseline protection) stay decoupled:
  // a manifest-less app (full-stack, static, main-chat editing an unscaffolded
  // app) is untouched; a scaffolded app's config files are locked.
  let root: string;
  const rel = "workspace/apps";

  function appFile(app: string, rest: string): string {
    return join(root, rel, app, rest);
  }
  function scaffold(app: string, ownedPaths: string[]): void {
    const dir = join(root, rel, app, ".lax");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scaffold.json"), JSON.stringify({ framework: "vite", ownedPaths }));
  }

  const OWNED = ["package.json", "package-lock.json", "vite.config.ts", "tsconfig.json"];

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wg-scaffold-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("REJECTS a package.json write in a scaffolded app", () => {
    scaffold("shopper", OWNED);
    const r = checkAppWrite(appFile("shopper", "package.json"), `{ "name": "x" }`);
    expect(r.allow).toBe(false);
    expect(r.message).toMatch(/locked/i);
    expect(r.message).toMatch(/src\//);
  });

  it("REJECTS vite.config.ts and tsconfig.json in a scaffolded app", () => {
    scaffold("shopper", OWNED);
    expect(checkAppWrite(appFile("shopper", "vite.config.ts"), "export default {}").allow).toBe(false);
    expect(checkAppWrite(appFile("shopper", "tsconfig.json"), "{}").allow).toBe(false);
  });

  it("ALLOWS a src/ write in a scaffolded app (model's own code)", () => {
    scaffold("shopper", OWNED);
    const r = checkAppWrite(appFile("shopper", "src/App.tsx"), "export default function App(){return null}");
    expect(r.allow).toBe(true);
  });

  it("ALLOWS a package.json write in a manifest-LESS app (full-stack authors its own)", () => {
    mkdirSync(join(root, rel, "backend"), { recursive: true });
    const r = checkAppWrite(appFile("backend", "package.json"), `{ "name": "api" }`);
    expect(r.allow).toBe(true);
  });

  it("does not block on a corrupt manifest", () => {
    const dir = join(root, rel, "broken", ".lax");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scaffold.json"), "{ not json");
    expect(checkAppWrite(appFile("broken", "package.json"), "{}").allow).toBe(true);
  });
});

describe("write-guard — built-artifact warn (run-target manifest-driven, never blocks)", () => {
  // Warn keys off .lax/run-target.json (mode: static-build) — the same marker
  // the request handler serves dist/ from. No manifest (or a corrupt one) means
  // no warn: fail-open, unmarked apps untouched. The warn NEVER weakens a
  // block — a baseline-locked path still rejects.
  let root: string;
  const rel = "workspace/apps";
  const JS = "console.log('built');".repeat(20);

  function appFile(app: string, rest: string): string {
    return join(root, rel, app, rest);
  }
  function runTarget(app: string, distDir: string): void {
    const dir = join(root, rel, app, ".lax");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run-target.json"), JSON.stringify({ mode: "static-build", distDir, framework: "vite" }));
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wg-runtarget-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("WARNS (allow: true) on a write under distDir when the manifest says static-build", () => {
    runTarget("shopper", "dist");
    const r = checkAppWrite(appFile("shopper", "dist/assets/index-abc123.js"), JS);
    expect(r.allow).toBe(true);
    expect(r.warn).toMatch(/build artifact/i);
    expect(r.warn).toMatch(/app_rebuild/);
  });

  it("no warn on the same path when NO run-target manifest exists", () => {
    mkdirSync(join(root, rel, "shopper"), { recursive: true });
    const r = checkAppWrite(appFile("shopper", "dist/assets/index-abc123.js"), JS);
    expect(r.allow).toBe(true);
    expect(r.warn).toBeUndefined();
  });

  it("no warn (and still allow) on a corrupt run-target manifest — fail-open", () => {
    const dir = join(root, rel, "shopper", ".lax");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run-target.json"), "{ not json");
    const r = checkAppWrite(appFile("shopper", "dist/assets/index-abc123.js"), JS);
    expect(r.allow).toBe(true);
    expect(r.warn).toBeUndefined();
  });

  it("no warn on source files outside distDir in a static-build app", () => {
    runTarget("shopper", "dist");
    const r = checkAppWrite(appFile("shopper", "src/App.tsx"), "export default function App(){return null}");
    expect(r.allow).toBe(true);
    expect(r.warn).toBeUndefined();
  });

  it("root-serving app (distDir '.'): warns on assets/ only when a sibling src/ exists", () => {
    runTarget("rooty", ".");
    mkdirSync(join(root, rel, "rooty", "src"), { recursive: true });
    const r = checkAppWrite(appFile("rooty", "assets/index-abc123.js"), JS);
    expect(r.allow).toBe(true);
    expect(r.warn).toMatch(/build artifact/i);
    // src/ itself is never artifact territory, even with distDir "."
    const src = checkAppWrite(appFile("rooty", "src/main.tsx"), JS);
    expect(src.warn).toBeUndefined();
  });

  it("root-serving app WITHOUT a src/ dir: no warn (assets may BE the source)", () => {
    runTarget("rooty", ".");
    const r = checkAppWrite(appFile("rooty", "assets/index-abc123.js"), JS);
    expect(r.allow).toBe(true);
    expect(r.warn).toBeUndefined();
  });

  it("warn never weakens the baseline lock: a locked path under distDir still BLOCKS", () => {
    runTarget("shopper", "dist");
    const lax = join(root, rel, "shopper", ".lax");
    mkdirSync(lax, { recursive: true });
    writeFileSync(join(lax, "scaffold.json"), JSON.stringify({ framework: "vite", ownedPaths: ["dist/vendor.js"] }));
    const r = checkAppWrite(appFile("shopper", "dist/vendor.js"), JS);
    expect(r.allow).toBe(false);
    expect(r.warn).toBeUndefined();
  });

  it("non-apps-dir paths never warn", () => {
    const r = checkAppWrite("/abs/src/foo.ts", JS);
    expect(r.allow).toBe(true);
    expect(r.warn).toBeUndefined();
  });
});

describe("write-guard — rejection message format", () => {
  it("includes the reason and points at AGENTS.md / inline-or-self-host", () => {
    const msg = writeGuardRejectionMessage("references blocked CDN host 'unpkg.com'");
    expect(msg).toContain("Write rejected");
    expect(msg).toContain("unpkg.com");
    expect(msg).toContain("AGENTS.md");
    expect(msg).toMatch(/inline.*self-host/i);
  });
});
