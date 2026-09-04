/**
 * The static-build smoke gate must exercise an app the way the LAX server
 * actually serves it — same origin scheme, same `/apps/<id>/` mount, same
 * Content-Security-Policy, same request→file resolution.
 *
 * It used to load builds from `file://`, which has none of those: a
 * cross-origin `fetch` the served app can NEVER make succeeded during the
 * smoke, and a root-absolute `<script src="/main.js">` resolved off the
 * filesystem root instead of 404ing. The gate judged a page the user would
 * never see, and a static source scan had to stand in for the missing
 * evidence. These tests are that evidence: they drive the REAL runAppSmokeGate
 * against real pages in a real browser.
 *
 * Browser-dependent, so they are gated on a launchable chromium (the gate
 * itself reports "skipped" without one — an environment problem is never a
 * build verdict). The serving-parity and origin-behaviour tests below need no
 * browser and always run.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runAppSmokeGate } from "../src/canonical-loop/adapters/app-build-smoke-gate.js";
import { startStaticSmokeOrigin } from "../src/canonical-loop/adapters/app-build-smoke-origin.js";
import { writeRunTargetManifest } from "../src/tools/app-run-target.js";
import { WORKSPACE_APP_HTML_HEADERS } from "../src/server/app-serving-policy.js";
import { serveWorkspaceApp, type AppServingDeps } from "../src/server/workspace-app-serving.js";
import type { LAXConfig } from "../src/types.js";

/** Lets ONE test force the loopback-bind failure a build box can genuinely hit
 *  (port exhaustion, firewall, EMFILE) while every other test keeps the real
 *  origin. There is no other seam: the gate starts the origin itself. */
const originControl = vi.hoisted(() => ({ bindError: null as string | null }));
vi.mock("../src/canonical-loop/adapters/app-build-smoke-origin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/canonical-loop/adapters/app-build-smoke-origin.js")>();
  return {
    ...actual,
    startStaticSmokeOrigin: async (appDir: string) => {
      if (originControl.bindError) throw new Error(originControl.bindError);
      return actual.startStaticSmokeOrigin(appDir);
    },
  };
});

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  originControl.bindError = null;
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** An app dir. Keys may contain "/" to place a file in a subdirectory. */
function appDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-csp-"));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

/** A JSON endpoint on `host`, CORS-open so only the CSP can be what blocks it. */
async function startDataServer(host: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ msg: "data arrived" }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

/** A page whose body is present either way, so the ONLY thing a verdict can
 *  turn on is whether the request to `dataUrl` was allowed. */
function fetchingPage(dataUrl: string): string {
  return `<!doctype html><html><body><h1>Data app</h1><div id="root">loading</div>` +
    `<script>fetch(${JSON.stringify(dataUrl)}).then(function (r) { return r.json(); })` +
    `.then(function (d) { document.getElementById('root').textContent = d.msg; })` +
    `.catch(function (e) { console.error('data fetch failed: ' + e.message); });</script></body></html>`;
}

/** Probed once at collection so the browser suite SKIPS (visibly) rather than
 *  passing vacuously on a box with no chromium. */
const chromiumAvailable = await (async () => {
  try {
    const { chromium } = await import("playwright");
    await (await chromium.launch({ headless: true })).close();
    return true;
  } catch { return false; }
})();

describe.skipIf(!chromiumAvailable)("static-build smoke runs under the REAL serving policy", () => {
  // The whole point: at file:// this app rendered "data arrived" and passed.
  // Under the policy the user's browser applies, the call never happens.
  it("an app whose content depends on a cross-origin call FAILS, naming the blocked URL [regression]", async () => {
    // ::1 is loopback — reachable from this box, so the request genuinely
    // SUCCEEDS without a CSP — but it is not `http://127.0.0.1:*` or
    // `http://localhost:*`, so the policy refuses it. That makes the verdict
    // attributable to the policy and not to an unreachable host.
    const dataUrl = await startDataServer("::1");
    const appDir = appDirWith({ "index.html": fetchingPage(dataUrl + "/data.json") });
    const outcome = await runAppSmokeGate({ appDir, mode: "strict" });
    expect(outcome.verdict).toBe("fail");
    // Chromium's own refusal message — which names the blocked URL and the
    // violated directive — IS the detail. The gate adds no advice of its own:
    // the same console-error channel carries refused stylesheets and CDN
    // scripts too, whose remedy is different, and the verdict is already
    // correct and attributable without a guess about which one this is.
    expect(outcome.detail).toContain("Content Security Policy");
    expect(outcome.detail).toContain("connect-src");
    expect(outcome.detail).toContain("http://[::1]");
    // Nothing is spliced in AFTER the browser's message: the detail is the
    // quoted console error and then the screenshot evidence, full stop. A hint
    // here could only guess which refusal this is — console errors carry
    // blocked stylesheets and CDN scripts too (remedy: self-host), while the
    // connect-src case this wording targeted is already rejected at verify
    // layer 1 by scanAppForBlockedFetch, before the smoke ever runs.
    expect(outcome.detail).toContain(`". A screenshot of what the app actually rendered is saved at`);
  }, 120_000);

  it("an app that renders locally and calls nothing still PASSES", async () => {
    // The module script is deliberate: at file:// it was refused as a
    // cross-origin module and the strict gate failed a perfectly good build.
    const appDir = appDirWith({
      "index.html": `<!doctype html><html><body><h1>Offline app</h1><div id="root"></div>` +
        `<script type="module" src="./main.js"></script></body></html>`,
      "main.js": `document.getElementById('root').textContent = 'rendered locally, no network';`,
    });
    const outcome = await runAppSmokeGate({ appDir, mode: "strict" });
    expect(outcome.detail).toBeUndefined();
    expect(outcome.verdict).toBe("pass");
  }, 120_000);

  it("a loopback call (http://127.0.0.1:PORT/...) is still permitted", async () => {
    // connect-src admits loopback so apps can talk to their own dev server.
    // The page console.errors on failure, which strict mode fails on — so a
    // pass here means the request actually completed.
    const dataUrl = await startDataServer("127.0.0.1");
    const appDir = appDirWith({ "index.html": fetchingPage(dataUrl + "/data.json") });
    const outcome = await runAppSmokeGate({ appDir, mode: "strict" });
    expect(outcome.detail).toBeUndefined();
    expect(outcome.verdict).toBe("pass");
  }, 120_000);

  // Production serves apps at /apps/<id>/, never at the origin root. A build
  // with the Vite `base: "/"` default therefore 404s every asset for the user.
  // If the gate served at the root instead, this app would load perfectly and
  // ship broken — the exact detection regression this test pins shut.
  it("a build using ROOT-ABSOLUTE asset paths FAILS, as it would for the user [regression]", async () => {
    const appDir = appDirWith({
      "index.html": `<!doctype html><html><body><h1>Rooted app</h1><div id="root">loading</div>` +
        `<script src="/main.js"></script></body></html>`,
      "main.js": `fetch("/data.json").then(function (r) { return r.json(); })` +
        `.then(function (d) { document.getElementById('root').textContent = d.msg; });`,
      "data.json": JSON.stringify({ msg: "data arrived" }),
    });
    const outcome = await runAppSmokeGate({ appDir, mode: "strict" });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain("404");
  }, 120_000);

  // When a run-target manifest exists the server serves dist/, so dist/ is the
  // page under test. Judging the source tree means passing a build whose
  // shipped output is broken.
  it("an app with a dist/ manifest is judged on the BUILT page, not the source [regression]", async () => {
    const appDir = appDirWith({
      // A perfectly healthy source page — the one round-1 would have judged.
      "index.html": `<!doctype html><html><body><h1>Source</h1><div id="root">source is fine</div></body></html>`,
      // …and a broken build output, which is what the user actually gets.
      "dist/index.html": `<!doctype html><html><body><h1>Built</h1><div id="root">built</div>` +
        `<script>console.error("the built bundle is broken");</script></body></html>`,
    });
    writeRunTargetManifest(appDir, { mode: "static-build", distDir: "dist", framework: "vite" });
    const outcome = await runAppSmokeGate({ appDir, mode: "strict" });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.detail).toContain("the built bundle is broken");
  }, 120_000);
});

describe("the smoke origin serves what the real route serves", () => {
  it("mounts the app at /apps/<id>/, exactly where production does", async () => {
    const appDir = appDirWith({ "index.html": "<!doctype html><p>hi</p>" });
    const origin = await startStaticSmokeOrigin(appDir);
    try {
      expect(new URL(origin.url).pathname).toBe(`/apps/${basename(appDir)}/`);
      const root = await fetch(new URL("/", origin.url));
      await root.text();
      // Off-mount is where production stops serving the app's files.
      expect(root.status).toBe(404);
      const mounted = await fetch(origin.url);
      expect(mounted.status).toBe(200);
      expect(await mounted.text()).toContain("hi");
    } finally {
      await origin.close();
    }
  }, 30_000);

  it("serves dist/ and its SPA fallback when a run-target manifest exists", async () => {
    const appDir = appDirWith({
      "index.html": "<!doctype html><p>source</p>",
      "dist/index.html": "<!doctype html><p>built</p>",
    });
    writeRunTargetManifest(appDir, { mode: "static-build", distDir: "dist", framework: "vite" });
    const origin = await startStaticSmokeOrigin(appDir);
    try {
      expect(await (await fetch(origin.url)).text()).toContain("built");
      // Client-side route: extensionless miss falls back to index.html.
      const deep = await fetch(new URL("./some/client/route", origin.url));
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain("built");
      // An extension'd miss must still 404 — the fallback is for routes, not
      // for a genuinely absent asset, which the gate needs to SEE.
      const missing = await fetch(new URL("./nope.js", origin.url));
      await missing.text();
      expect(missing.status).toBe(404);
    } finally {
      await origin.close();
    }
  }, 30_000);

  it("answers a directory request instead of hanging the socket [regression]", async () => {
    // readFileSync on a directory throws EISDIR from inside the request
    // listener: no response is ever written, the socket hangs, and page.goto
    // stalls to its full 30s budget — a false FAIL on a healthy build.
    const appDir = appDirWith({ "index.html": "<!doctype html><p>hi</p>", "assets/app.css": "body{}" });
    const origin = await startStaticSmokeOrigin(appDir);
    try {
      const res = await fetch(new URL("./assets", origin.url), { signal: AbortSignal.timeout(5_000) });
      await res.text();
      expect(res.status).toBe(404);
      // The listener is still alive and serving after it.
      expect((await fetch(origin.url)).status).toBe(200);
    } finally {
      await origin.close();
    }
  }, 30_000);
});

describe("smoke origin and the real route serve ONE policy", () => {
  // Guards the reason the gate can be trusted: if these ever diverge, the gate
  // is testing a policy the user never gets.
  it("the smoke origin's HTML headers match the real route AND the pinned policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "smoke-csp-route-"));
    tempDirs.push(root);
    const appDir = join(root, "apps", "demo");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "index.html"), "<!doctype html><html><body><p>hi</p></body></html>");

    const config = { workspace: root, authToken: "operator-token" } as LAXConfig;
    const deps: AppServingDeps = {
      readDevServerRecord: () => null,
      ensureFrameworkRegistered: () => {},
      ensureDevServerRunning: () => { throw new Error("no dev server in this test"); },
      proxyFrontendDevServer: () => {},
    };
    const route = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!serveWorkspaceApp(req.method || "GET", url, req, res, config, root, deps)) { res.writeHead(404); res.end(); }
    });
    servers.push(route);
    await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
    const routePort = (route.address() as AddressInfo).port;

    const origin = await startStaticSmokeOrigin(appDir);
    try {
      const fromRoute = await fetch(`http://127.0.0.1:${routePort}/apps/demo/index.html`);
      await fromRoute.text();
      const fromOrigin = await fetch(new URL("./index.html", origin.url));
      await fromOrigin.text();
      // Equality alone can never catch BOTH sides dropping a header together,
      // so every header is also pinned to its literal policy value.
      for (const [name, value] of Object.entries(WORKSPACE_APP_HTML_HEADERS)) {
        const h = name.toLowerCase();
        expect(fromRoute.headers.get(h), `route header ${h}`).toBe(value);
        expect(fromOrigin.headers.get(h), `smoke-origin header ${h}`).toBe(value);
      }
      expect(fromRoute.headers.get("content-type")).toBe("text/html");
      expect(fromOrigin.headers.get("content-type")).toBe("text/html");
      // The policy itself must keep saying the two things the gate relies on.
      expect(WORKSPACE_APP_HTML_HEADERS["Content-Security-Policy"])
        .toContain("connect-src 'self' http://127.0.0.1:* http://localhost:*");
      expect(Object.keys(WORKSPACE_APP_HTML_HEADERS)).toEqual([
        "Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options",
        "Referrer-Policy", "Permissions-Policy", "Cache-Control", "Pragma",
      ]);
    } finally {
      await origin.close();
    }
  }, 30_000);
});

describe("an infrastructure failure is never mistaken for a clean build", () => {
  it("a loopback bind failure FAILS loudly instead of skipping the gate [regression]", async () => {
    // "skipped" is treated as done by the verify adapter, so a firewalled or
    // port-exhausted box would ship every build unverified and look identical
    // to a passing smoke.
    originControl.bindError = "EADDRINUSE: no loopback port available";
    const appDir = appDirWith({ "index.html": "<!doctype html><p>hi</p>" });
    const outcome = await runAppSmokeGate({ appDir, mode: "strict" });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.verdict).not.toBe("skipped");
    expect(outcome.detail).toContain("NOT verified");
    expect(outcome.detail).toContain("EADDRINUSE");
    // …and it must say plainly that the app is not the thing to fix — in the
    // prose AND on the machine-readable channel, which is what the verify
    // adapter turns into its own error code (app_smoke_environment_failed).
    expect(outcome.detail).toContain("environment failure");
    expect(outcome.failureKind).toBe("environment");
  }, 30_000);
});
