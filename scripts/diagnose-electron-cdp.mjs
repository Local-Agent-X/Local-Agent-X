// Foundation check for the in-app CDP driver (campaign chunks C1 + C2).
// Run this AFTER restarting the desktop app on the new build and opening an
// in-app browser view (e.g. navigate the Browser panel to a real site). It
// drives the ACTUAL shipped connector (dist/browser/electron-cdp.js), not a
// reimplementation, so a PASS here means C3 can build on a proven base.
//
//   node scripts/diagnose-electron-cdp.mjs            (auto-discovers the port)
//   node scripts/diagnose-electron-cdp.mjs --port 51234
//
// Throwaway: delete after the foundation is confirmed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USER_DATA = join(homedir(), "AppData", "Roaming", "Local Agent X");
const arg = process.argv.indexOf("--port");
let port = arg !== -1 ? Number(process.argv[arg + 1]) : NaN;

if (!Number.isInteger(port) || port <= 0) {
  try {
    const first = readFileSync(join(USER_DATA, "DevToolsActivePort"), "utf-8").split(/\r?\n/, 1)[0].trim();
    port = Number(first);
    console.log(`• Discovered CDP port ${port} from ${join(USER_DATA, "DevToolsActivePort")}`);
  } catch {
    console.error(
      `✗ No CDP port. Could not read ${join(USER_DATA, "DevToolsActivePort")}.\n` +
      `  Make sure the desktop app is RUNNING ON THE NEW BUILD (C1 sets --remote-debugging-port).\n` +
      `  If it is running, pass the port explicitly: --port <n>.`,
    );
    process.exit(2);
  }
}

process.env.LAX_ELECTRON_CDP_PORT = String(port);

const { connectElectronCdp, getPageForView, closeElectronCdp } = await import("../dist/browser/electron-cdp.js");

let ok = true;
const fail = (m) => { ok = false; console.error(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

const browser = await connectElectronCdp();
if (!browser) {
  fail("connectElectronCdp() returned null — endpoint unreachable at 127.0.0.1:" + port);
  process.exit(1);
}
pass(`connectElectronCdp() attached to the embedded Electron browser (port ${port})`);

// Enumerate every page and read its per-view marker (window.name), exactly the
// way C2's getPageForView maps a viewId to a Page.
const seen = [];
for (const context of browser.contexts()) {
  for (const page of context.pages()) {
    let name = "";
    try { name = String(await page.evaluate("window.name")); } catch { name = "<eval failed>"; }
    let url = "";
    try { url = page.url(); } catch { /* ignore */ }
    seen.push({ page, name, url });
  }
}
console.log(`\nPages visible over CDP: ${seen.length}`);
for (const s of seen) console.log(`   name=${JSON.stringify(s.name)}  url=${s.url.slice(0, 90)}`);

// In-app agent/user views are stamped with a view-<sessionId>-<profile> marker.
const views = seen.filter((s) => s.name.startsWith("view-"));
if (views.length === 0) {
  fail("No page carries a view-* marker. Open an in-app Browser view first (navigate the Browser panel to a page), then re-run.");
} else {
  pass(`${views.length} in-app view page(s) carry a view-* marker`);
}

// Round-trip the real C2 resolver for each discovered marker, and prove CDP can
// see INTO the page's frames (the iframe the legacy bridge could not reach).
for (const v of views) {
  const resolved = await getPageForView(v.name);
  if (resolved === v.page) pass(`getPageForView(${JSON.stringify(v.name)}) resolved the correct Page`);
  else fail(`getPageForView(${JSON.stringify(v.name)}) did NOT resolve the expected Page`);

  try {
    const frames = v.page.frames();
    const sub = frames.filter((f) => f !== v.page.mainFrame());
    console.log(`   ${v.name}: ${frames.length} frame(s), ${sub.length} sub-frame(s):`);
    for (const f of sub) console.log(`      ↳ ${f.url().slice(0, 100)}`);
    if (sub.length > 0) pass(`CDP reaches ${sub.length} sub-frame(s) on ${v.name} — frameLocator can drive an iframe here`);
    else console.log(`   (no sub-frames on this page — open one with an iframe, e.g. the Thrive PO form, to prove iframe reach)`);
  } catch (e) {
    fail(`frame enumeration failed on ${v.name}: ${e.message}`);
  }
}

// Deliberately do NOT call closeElectronCdp()/browser.close() against a LIVE
// user app — just drop the CDP connection by exiting, so nothing can disturb it.
void closeElectronCdp;
console.log(`\n${ok ? "RESULT: PASS — C1 endpoint + C2 connector work against the live app. Safe to build C3." : "RESULT: FAIL — see ✗ lines above."}`);
process.exit(ok ? 0 : 1);
