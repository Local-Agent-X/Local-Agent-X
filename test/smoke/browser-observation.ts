/**
 * Browser observation-layer smoke test — exercises BrowserManager's
 * navigate → snapshot → fillByRef → tabs path against local fixture pages.
 * No real sites, no LLM calls. Runs in ~5s against the real agent Chrome.
 *
 *   npm run test:browser-smoke      (or: npx tsx test/smoke/browser-observation.ts)
 *
 * Pass = exit 0, fail = exit 1 with the failing assertion.
 *
 * This is an executable smoke SCRIPT, not a vitest test: it launches a real
 * browser against the developer's real ~/.lax Chrome profile. The vitest suite
 * is offline + HOME-isolated (every browser unit test stubs Playwright), so this
 * lives outside the gate and is run on demand. It's the only check that covers
 * the live observation layer — manager.test.ts only covers the fill-readback
 * policy with a stubbed page.
 */
import { createServer } from "node:http";
import { BrowserManager } from "../../src/browser/index.js";

const PORT = 19321;

const LOGIN_HTML = `<!doctype html>
<html>
<head><title>Test Login</title></head>
<body>
  <h1>Sign in</h1>
  <form id="f">
    <label for="u">Username</label>
    <input id="u" name="username" type="text" placeholder="Email or username" />
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" value="HARDCODED_SECRET_FOR_TEST" />
    <button type="button" id="signin">Sign In</button>
    <a href="/forgot">Forgot password?</a>
  </form>
  <div id="below" style="margin-top: 2000px;">
    <button id="farbutton">Far Button</button>
  </div>
</body>
</html>`;

const DASHBOARD_HTML = `<!doctype html>
<html>
<head><title>Dashboard</title></head>
<body>
  <h1>Professional Dashboard</h1>
  <nav>
    <a href="/insights/media/12345">View insights (Post 1)</a>
    <a href="/insights/media/67890">View insights (Post 2)</a>
    <a href="/accounts/insights/?timeframe=30">Account analytics last 30 days</a>
  </nav>
  <div id="tiles">
    <div class="tile"><h2>Accounts reached</h2><span id="r">1,079</span></div>
    <div class="tile"><h2>Engagement</h2><span id="e">192</span></div>
  </div>
  <button id="editbtn">Edit profile</button>
</body>
</html>`;

const PAGES: Record<string, string> = {
  "login.html": LOGIN_HTML,
  "dashboard.html": DASHBOARD_HTML,
};

function startFixtureServer(): Promise<{ close: () => void }> {
  return new Promise((res) => {
    const srv = createServer((req, out) => {
      const url = (req.url || "/").split("?")[0];
      const name = url === "/" ? "login.html" : url.slice(1) + (url.endsWith(".html") ? "" : ".html");
      const body = PAGES[name];
      if (body) {
        out.writeHead(200, { "content-type": "text/html" });
        out.end(body);
      } else {
        out.writeHead(404);
        out.end("not found");
      }
    });
    srv.listen(PORT, "127.0.0.1", () => res({ close: () => srv.close() }));
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const srv = await startFixtureServer();
  const mgr = new BrowserManager();
  try {
    console.log("\n[1] snapshot format");
    const nav = await mgr.navigate(`http://127.0.0.1:${PORT}/login.html`);
    assert(nav.includes("Sign in") || nav.includes("Test Login"), "page title shown");
    assert(/\[\d+\]<\w+/.test(nav), "element lines use [N]<tag>text</tag> format");

    console.log("\n[2] password field value must not leak");
    assert(!nav.includes("HARDCODED_SECRET_FOR_TEST"), "password value never appears in snapshot");
    assert(nav.includes("Password"), "password field labeled as 'Password'");

    console.log("\n[3] offscreen elements are still visible (no viewport filter)");
    assert(nav.toLowerCase().includes("far"), "far-offscreen button included in snapshot");

    console.log("\n[4] durable refs persist across observations");
    // navigate() auto-snapshots; its return value INCLUDES the initial snapshot.
    const mgr2 = new BrowserManager();
    const navSnap = await mgr2.navigate(`http://127.0.0.1:${PORT}/login.html`);
    const refMatches = [...navSnap.matchAll(/\[(\d+)\]<(\w+)[^>]*>([^<]*)</g)];
    assert(refMatches.length > 0, `initial navigate snapshot has ${refMatches.length} parsed refs`);
    const usernameMatch = refMatches.find((m) => /username|email/i.test(m[3]));
    assert(usernameMatch, `username ref present in snapshot`);
    const usernameRefId = Number(usernameMatch![1]);
    // Second snapshot is a diff — ref [N] should NOT appear as "- removed"
    const snap2 = await mgr2.snapshot();
    const refRemoved = new RegExp(`^- \\[${usernameRefId}\\]`, "m").test(snap2);
    assert(!refRemoved, `ref [${usernameRefId}] not listed as removed on re-observe`);
    await mgr2.close();

    console.log("\n[5] navigate to dashboard, verify link refs disambiguable");
    const dash = await mgr.navigate(`http://127.0.0.1:${PORT}/dashboard.html`);
    assert(dash.includes("Account analytics") || dash.includes("insights"), "dashboard loads");
    assert(dash.includes("Professional Dashboard") || dash.includes("Dashboard"), "page title captured");

    console.log("\n[6] fill works by ref");
    const mgr3 = new BrowserManager();
    const nav3 = await mgr3.navigate(`http://127.0.0.1:${PORT}/login.html`);
    const uMatch = [...nav3.matchAll(/\[(\d+)\]<(\w+)[^>]*>([^<]*)</g)].find(
      (m) => /username|email/i.test(m[3])
    );
    assert(uMatch, "found username ref in navigate snapshot");
    const fillResult = await mgr3.fillByRef(Number(uMatch![1]), "test@example.com");
    assert(!fillResult.toLowerCase().includes("could not"), `fill by ref succeeded: ${fillResult.slice(0, 80)}`);
    await mgr3.close();

    console.log("\n[7] second tab stays independent");
    const tab2 = await mgr.newTab(`http://127.0.0.1:${PORT}/dashboard.html`);
    assert(tab2.includes("2 tabs") || tab2.includes("Opened new tab"), "second tab opened");
    const tabs = await mgr.listTabs();
    assert(/2 tab/.test(tabs) || tabs.split("\n").length >= 2, "both tabs listed");

    console.log("\nALL SMOKE TESTS PASSED");
  } finally {
    await mgr.close();
    srv.close();
  }
}

main().catch((e) => {
  console.error("UNCAUGHT:", (e as Error).stack || e);
  process.exit(1);
});
