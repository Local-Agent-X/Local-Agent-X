/**
 * Real-browser proof of the stable-identifier resolution fix.
 *
 *   npx tsx test/smoke/browser-stable-resolution.ts
 *
 * The unit suite runs against happy-dom and a fake DOM; neither has
 * document.evaluate, real layout, or real iframes, so neither can answer the
 * questions that actually decide whether the agent can drive a form:
 *   - does the stored XPath resolve back to its element?
 *   - does the exact strategy find a field whose accessible name is empty?
 *   - does any of it work for a field inside a same-origin iframe?
 *
 * The fixture mirrors the shape that defeated the agent on the live
 * Thrive/Shopventory purchase-order page: an AngularJS-style host page with
 * three ui-select focussers that differ ONLY by id, plus a same-origin iframe
 * whose fields carry ids and HTML `name`s but no accessible name.
 *
 * Headless Chromium via Playwright — no profile, no network, no LLM. Out of the
 * vitest gate because it needs a browser binary (same rule as
 * browser-observation.ts). Pass = exit 0.
 */
import { createServer } from "node:http";
import { chromium } from "playwright";
import { ObservationRegistry, type DurableRef } from "../../src/browser/observation.js";
import { resolutionScript } from "../../src/browser/in-app-resolve-scripts.js";
import { fillRef } from "../../src/browser/actions.js";

const PORT = 19322;

const FRAME_HTML = `<!doctype html><html><body>
  <form>
    <label for="po-number">PO Number</label>
    <input id="po-number" name="PO NUMBER" placeholder="" type="text" />
    <label for="fees">Fees</label>
    <input id="fees" name="FEES" type="text" />
    <textarea id="vendor-msg" name="MESSAGE TO VENDOR" placeholder="Message to vendor"></textarea>
    <div><div><div><button data-testid="save-po">Save</button></div></div></div>
  </form>
</body></html>`;

const HOST_HTML = `<!doctype html><html><head><title>Purchase Order</title></head><body>
  <h1>Create Purchase Order</h1>
  <!-- ui-select focussers: identical structure, identical (empty) name, ids only -->
  <div class="row"><div class="ui-select"><div class="wrap"><input id="focusser-0" name="" type="text"></div></div></div>
  <div class="row"><div class="ui-select"><div class="wrap"><input id="focusser-1" name="" type="text"></div></div></div>
  <div class="row"><div class="ui-select"><div class="wrap"><input id="focusser-2" name="" type="text"></div></div></div>
  <!-- No id anywhere on the path: the case whose stored XPath used to resolve
       to nothing, leaving fill with no non-coordinate strategy at all. -->
  <div class="toolbar"><div class="grp"><button>Add line item</button></div></div>
  <iframe src="/frame.html" width="900" height="500" style="border:0"></iframe>
</body></html>`;

const PAGES: Record<string, string> = { "/": HOST_HTML, "/frame.html": FRAME_HTML };

function startFixtureServer(): Promise<{ close: () => void }> {
  return new Promise((res) => {
    const srv = createServer((req, out) => {
      const body = PAGES[(req.url || "/").split("?")[0]];
      out.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      out.end(body ?? "not found");
    });
    srv.listen(PORT, "127.0.0.1", () => res({ close: () => srv.close() }));
  });
}

let failed = false;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.error(`  FAIL ${msg}`); failed = true; }
}

async function main(): Promise<void> {
  const srv = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
    const registry = new ObservationRegistry();
    const refs = (await registry.observe(page)).currentRefs;
    const byId = (id: string): DurableRef | undefined => refs.find((r) => r.ids?.id === id);

    console.log("\n[1] extraction records durable identity");
    const po = byId("po-number");
    assert(po, "PO field observed at all");
    assert(po?.ids?.name === "PO NUMBER", `PO field carries its HTML name (got ${JSON.stringify(po?.ids)})`);
    assert(byId("vendor-msg")?.ids?.placeholder === "Message to vendor", "textarea carries its placeholder");
    assert(refs.some((r) => r.ids?.testId === "save-po"), "button carries its data-testid");

    console.log("\n[2] the ui-select focussers are each addressable");
    const focussers = ["focusser-0", "focusser-1", "focusser-2"].filter((id) => byId(id));
    assert(focussers.length === 3, `all 3 focussers got their own ref (got ${focussers.length})`);
    assert(new Set(refs.map((r) => r.signature)).size === refs.length, "no two refs share a signature");

    console.log("\n[3] every stored XPath resolves back to its own element");
    // A STRING script, not a closure: tsx/esbuild rewrites function expressions
    // with a __name helper that does not exist in the page.
    const xpathProbe = `(() => {
      const list = ${JSON.stringify(refs.map((r) => ({ id: r.id, xpath: r.xpath, frameUrl: r.frameUrl })))};
      const docFor = (frameUrl) => {
        if (frameUrl === undefined) return document;
        for (const f of document.querySelectorAll("iframe")) {
          if (f.getAttribute("src") === frameUrl && f.contentDocument) return f.contentDocument;
        }
        return document;
      };
      const dead = [];
      for (const r of list) {
        if (!r.xpath) continue;
        const doc = docFor(r.frameUrl);
        let hit = null;
        try { hit = doc.evaluate(r.xpath, doc, null, 9, null).singleNodeValue; } catch { hit = null; }
        if (!hit) dead.push("[" + r.id + "] " + r.xpath);
      }
      return dead;
    })()`;
    const xpathMisses = await page.evaluate(xpathProbe) as string[];
    assert(xpathMisses.length === 0, `all ${refs.length} XPaths resolve (dead: ${xpathMisses.join(", ") || "none"})`);

    console.log("\n[4] the in-app resolution chain finds fields EXACTLY (iframe included)");
    for (const id of ["po-number", "fees", "focusser-2"]) {
      const ref = byId(id);
      if (!ref) { assert(false, `${id} has no ref to resolve`); continue; }
      const out = await page.evaluate(resolutionScript(ref, "fill")) as { found?: boolean; via?: string; key?: string };
      assert(out.found === true && out.via === "exact", `${id} resolved via ${out.via ?? "MISS"} ${out.key ?? ""}`);
    }

    console.log("\n[5] the CDP action path fills the iframe field by its stable id");
    const poRef = byId("po-number");
    if (!poRef) assert(false, "no PO ref to fill");
    else {
      const r = await fillRef(page, registry, poRef.id, "PO-4471");
      assert(r.ok && r.via === "exact", `fillRef reported: ${r.message}`);
      const written = await page.frames().find((f) => f.url().endsWith("/frame.html"))!
        .evaluate(`document.getElementById("po-number").value`) as string;
      assert(written === "PO-4471", `the field actually holds the value (got "${written}")`);
    }

    console.log(failed ? "\nSMOKE FAILED" : "\nALL SMOKE CHECKS PASSED");
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("UNCAUGHT:", (e as Error).stack || e);
  process.exit(1);
});
