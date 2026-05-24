/**
 * Tier 1 patch — write-time enforcement guard. Pure text checks that
 * reject obvious environment-contract violations (CDN references, missing
 * viewport meta) at the write/edit tool boundary so the build agent learns
 * within the same turn rather than waiting for a downstream CSP refusal.
 */
import { describe, it, expect } from "vitest";
import { checkAppWrite, writeGuardRejectionMessage } from "../src/app-tools/write-guard.js";

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

describe("write-guard — rejection message format", () => {
  it("includes the reason and points at AGENTS.md / inline-or-self-host", () => {
    const msg = writeGuardRejectionMessage("references blocked CDN host 'unpkg.com'");
    expect(msg).toContain("Write rejected");
    expect(msg).toContain("unpkg.com");
    expect(msg).toContain("AGENTS.md");
    expect(msg).toMatch(/inline.*self-host/i);
  });
});
