import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanAppForBlockedFetch, formatBlockedFetchError, scanAppForStartupErrors, scanAppForUnverifiedNativeParity, formatUnverifiedNativeParity, scanAppForFakedFrontend, formatFakedFrontend } from "./app-build-verify.js";

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

describe("scanAppForStartupErrors — catches blank-on-load builds", () => {
  it("passes a clean app whose script reference resolves", () => {
    const dir = makeApp({
      "index.html": `<script src="app.js"></script>`,
      "app.js": `console.log("hi");`,
    });
    expect(scanAppForStartupErrors(dir).errors).toHaveLength(0);
  });

  it("flags an app with no HTML entry point", () => {
    const dir = makeApp({ "app.js": `console.log("orphan");` });
    const { errors } = scanAppForStartupErrors(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0].problem).toMatch(/no HTML/i);
  });

  it("flags a <script src> that points at a missing file", () => {
    const dir = makeApp({ "index.html": `<script src="main.js"></script>` });
    const { errors } = scanAppForStartupErrors(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("index.html");
    expect(errors[0].problem).toMatch(/missing script "main\.js"/);
  });

  it("resolves a root-absolute script path against the app root", () => {
    const dir = makeApp({
      "index.html": `<script src="/js/app.js"></script>`,
      "js/app.js": `console.log("ok");`,
    });
    expect(scanAppForStartupErrors(dir).errors).toHaveLength(0);
  });

  it("ignores external/CDN and inline scripts (a different, non-missing-file concern)", () => {
    const dir = makeApp({
      "index.html":
        `<script src="https://cdn.example.com/x.js"></script>` +
        `<script src="//cdn.example.com/y.js"></script>` +
        `<script>console.log("inline ok");</script>`,
    });
    expect(scanAppForStartupErrors(dir).errors).toHaveLength(0);
  });
});

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

describe("scanAppForUnverifiedNativeParity — catches the compiled-lang JS-twin lie", () => {
  // Reproduces the reported scenario: real Rust source sidelined, a JS twin in
  // index.html labeled "identical to Rust output" — a claim the browser can't verify.
  it("flags a Rust app whose index.html claims its preview is identical to the Rust output", () => {
    const dir = makeApp({
      "src/main.rs": "fn main() { /* 326-line raytracer */ }",
      "index.html": "<canvas id=c></canvas><div>✅ Render complete — identical to Rust output</div><script>/* JS twin */</script>",
    });
    const { violations } = scanAppForUnverifiedNativeParity(dir);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe("index.html");
    expect(violations[0].claim.toLowerCase()).toContain("identical to");
  });

  it("flags a Go app claiming a 1:1 match", () => {
    const dir = makeApp({
      "main.go": "package main\nfunc main() {}",
      "index.html": "<p>This canvas is a 1:1 match of the Go binary's frames.</p>",
    });
    expect(scanAppForUnverifiedNativeParity(dir).violations.length).toBe(1);
  });

  it("does NOT flag a pure web app even when it claims to match a mockup (no compiled source)", () => {
    const dir = makeApp({
      "index.html": "<p>Pixel-perfect, identical to the Figma mockup.</p><script>app()</script>",
    });
    expect(scanAppForUnverifiedNativeParity(dir).violations.length).toBe(0);
  });

  it("does NOT flag a compiled-lang app that honestly shows its real produced artifact", () => {
    const dir = makeApp({
      "src/main.rs": "fn main() { /* writes output.png */ }",
      "output.png": "\x89PNG fake bytes",
      "index.html": "<img src=output.png alt='rendered by the actual Rust program (cargo run)'>",
    });
    expect(scanAppForUnverifiedNativeParity(dir).violations.length).toBe(0);
  });

  it("does NOT mistake a real cargo build artifact for an honesty problem", () => {
    const dir = makeApp({
      "src/main.rs": "fn main() {}",
      "target/debug/app": "binary",
      "index.html": "<img src=out.png>",
    });
    expect(scanAppForUnverifiedNativeParity(dir).violations.length).toBe(0);
  });

  it("formats a message naming the file + the two honest exits", () => {
    const msg = formatUnverifiedNativeParity([{ file: "index.html", claim: "identical to" }]);
    expect(msg).toContain("index.html");
    expect(msg).toContain("cargo run");
    expect(msg).toContain("remove the equivalence claim");
    expect(msg).toContain("Never claim parity you didn't verify");
  });
});

describe("scanAppForFakedFrontend — catches a frontend-spa build faked as a static page", () => {
  it("flags an app with NO package.json (a static HTML fake of a framework)", () => {
    const dir = makeApp({ "index.html": "<html><body>Vite React Sample (static mock)</body></html>" });
    const r = scanAppForFakedFrontend(dir);
    expect(r.faked).toBe(true);
    expect(r.reason).toMatch(/no package\.json/i);
  });

  it("flags a package.json that declares no framework / build tool", () => {
    const dir = makeApp({ "package.json": JSON.stringify({ name: "x", dependencies: { lodash: "^4" } }) });
    expect(scanAppForFakedFrontend(dir).faked).toBe(true);
  });

  it("passes a REAL Vite+React project (package.json declares the framework)", () => {
    const dir = makeApp({
      "package.json": JSON.stringify({
        name: "spa",
        dependencies: { react: "latest", "react-dom": "latest", vite: "latest", "@vitejs/plugin-react": "latest" },
      }),
      "vite.config.js": "export default {}",
    });
    expect(scanAppForFakedFrontend(dir).faked).toBe(false);
  });

  it("formats an actionable message pointing at a real scaffold + app_serve_frontend", () => {
    const msg = formatFakedFrontend("there is no package.json");
    expect(msg).toContain("app_serve_frontend");
    expect(msg).toContain("package.json");
    expect(msg).toMatch(/not the app/i);
  });
});
