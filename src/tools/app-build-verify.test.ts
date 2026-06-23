import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanAppForBlockedFetch, formatBlockedFetchError } from "./app-build-verify.js";

const dirs: string[] = [];
function makeApp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-appverify-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("scanAppForBlockedFetch — flags raw cross-origin fetch", () => {
  // Regression for the grok-code-fast weather app: endpoint in a variable, then
  // fetched. The CSP blocks it at runtime; the gate must catch it at build time.
  it("flags an external endpoint assigned to a variable and fetched", () => {
    const dir = makeApp({
      "index.html": `<script type="module" src="app.js"></script>`,
      "weatherApi.js": `const URL='https://api.open-meteo.com/v1/forecast';\nasync function go(){const r=await fetch(URL+'?x=1');return r.json();}`,
    });
    const { violations } = scanAppForBlockedFetch(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("weatherApi.js");
    expect(violations[0].hosts).toContain("api.open-meteo.com");
  });

  it("flags a raw fetch inside an inline <script> in index.html", () => {
    const dir = makeApp({
      "index.html": `<html><body><script>fetch('https://api.example.com/data').then(r=>r.json());</script></body></html>`,
    });
    const { violations } = scanAppForBlockedFetch(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].hosts).toContain("api.example.com");
  });
});

describe("scanAppForBlockedFetch — does NOT flag legitimate patterns", () => {
  it("passes the connector pattern (relative /api/connectors, same-origin)", () => {
    const dir = makeApp({
      "app.js": `const t=window.__LAX_CONNECTOR_TOKEN__;\nfetch('/api/connectors/coingecko/api/v3/simple/price',{headers:{Authorization:'Bearer '+t}});`,
    });
    expect(scanAppForBlockedFetch(dir).violations).toHaveLength(0);
  });

  it("passes loopback URLs (reachable under the app CSP)", () => {
    const dir = makeApp({ "app.js": `fetch('http://127.0.0.1:7007/api/x');fetch('http://localhost:7860/health');` });
    expect(scanAppForBlockedFetch(dir).violations).toHaveLength(0);
  });

  it("passes SVG/XML namespace URIs even when fetch is present", () => {
    const dir = makeApp({
      "app.js": `const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');\nfetch('/api/connectors/x/y');`,
    });
    expect(scanAppForBlockedFetch(dir).violations).toHaveLength(0);
  });

  it("passes window.open / href navigation to an external URL", () => {
    const dir = makeApp({
      "app.js": `fetch('/api/connectors/x/y');\nwindow.open('https://stripe.com/checkout');\ndocument.querySelector('a').href='https://docs.example.com';`,
    });
    expect(scanAppForBlockedFetch(dir).violations).toHaveLength(0);
  });

  it("passes an app with no network calls (external URL only in an <a href>)", () => {
    const dir = makeApp({ "index.html": `<a href="https://example.com">link</a><p>static page</p>` });
    expect(scanAppForBlockedFetch(dir).violations).toHaveLength(0);
  });
});

describe("formatBlockedFetchError", () => {
  it("names the file, host, and the connector fix", () => {
    const msg = formatBlockedFetchError([{ file: "weatherApi.js", hosts: ["api.open-meteo.com"] }]);
    expect(msg).toContain("weatherApi.js");
    expect(msg).toContain("api.open-meteo.com");
    expect(msg).toContain("connector_create");
    expect(msg).toContain("/api/connectors/");
    expect(msg).toContain("window.__LAX_CONNECTOR_TOKEN__");
  });
});
