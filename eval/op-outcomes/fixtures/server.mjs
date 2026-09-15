// Fixture web server for the op-outcomes battery. Every page the cases drive
// is served from here on a loopback port, so a run never touches a real site
// or account, and every request is RECORDED — cases are graded on what the
// agent actually did (a form submission that arrived, a deploy call with the
// right bearer token), not on what its reply claims.
//
// Facts on these pages are invented on purpose so a model can't answer from
// training data instead of reading the page.
import { createServer } from "node:http";

const PAGE = (title, body, extraHead = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${extraHead}</head><body>${body}</body></html>`;

const PAGES = {
  "/fact/bridge": PAGE("Halvorsen Span — Harbor Heritage Registry",
    `<h1>Halvorsen Span</h1>
     <p>The Halvorsen Span is a cantilever footbridge over the Ostmark inlet.</p>
     <table><tr><th>Construction began</th><td>1911</td></tr>
     <tr><th>Opened to the public</th><td>1927</td></tr>
     <tr><th>Main span</th><td>212 m</td></tr></table>`),

  "/consent/news": PAGE("The Ostmark Courier",
    `<div id="consent" style="position:fixed;inset:0;background:rgba(0,0,0,.85);color:#fff;display:flex;align-items:center;justify-content:center;z-index:10">
       <div><p>We use cookies to run this site.</p>
       <button id="accept" onclick="document.getElementById('consent').remove();document.getElementById('story').hidden=false">Accept all</button>
       <button onclick="document.getElementById('consent').remove()">Reject</button></div></div>
     <main id="story" hidden><h1 id="headline">Harbor council approves the Lindqvist tidal barrier</h1></main>`),

  "/form/signup": PAGE("Devportal — Create organization account",
    `<h1>Create an organization account</h1>
     <form id="step1" onsubmit="event.preventDefault();document.getElementById('step1').hidden=true;document.getElementById('step2').hidden=false">
       <label>Legal name <input name="legalName" id="legalName" required></label>
       <label>Contact email <input name="email" id="email" type="email" required></label>
       <button type="submit">Next</button></form>
     <form id="step2" hidden method="post" action="/form/submit"
       onsubmit="document.getElementById('legalName2').value=document.getElementById('legalName').value;document.getElementById('email2').value=document.getElementById('email').value">
       <input type="hidden" name="legalName" id="legalName2"><input type="hidden" name="email" id="email2">
       <label>Entity type <select name="entityType" required>
         <option value="">Choose…</option><option value="individual">Individual / sole proprietor</option>
         <option value="business">Business (LLC, corporation)</option></select></label>
       <button type="submit">Create account</button></form>`),

  "/research/fieldflow/pricing": PAGE("FieldFlow — Pricing",
    `<h1>FieldFlow pricing</h1>
     <ul><li>Starter: $49 per month, 1 user</li><li>Crew: $129 per month, up to 5 users</li>
     <li>Fleet: $349 per month, unlimited users</li></ul>
     <p>See <a href="/research/fieldflow/payments">payment processing fees</a>.</p>`),
  "/research/fieldflow/payments": PAGE("FieldFlow — Payment fees",
    `<h1>Payment processing</h1>
     <p>Card payments collected through FieldFlow invoices are charged 2.9% + $0.30 per transaction.</p>
     <p>ACH bank transfers are charged a flat 1% capped at $10.</p>`),

  "/site/original": PAGE("Bellavista Wellness",
    `<header style="height:64px;display:flex;align-items:center;padding:0 24px"><strong>Bellavista</strong></header>
     <main><h1>Relax. Restore.</h1></main>
     <footer style="padding:24px"><div class="social" style="display:flex;justify-content:center;gap:16px">
       <a href="#">Instagram</a><a href="#">Facebook</a><a href="#">TikTok</a></div></footer>`),
};

export async function startFixtureServer() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://fixture");
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body, at: Date.now() });
      if (req.method === "GET" && PAGES[url.pathname]) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGES[url.pathname]);
        return;
      }
      if (req.method === "POST" && url.pathname === "/form/submit") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE("Account created", "<h1>Organization account created</h1><p>Enrollment ID: ENR-58213</p>"));
        return;
      }
      if (req.method === "POST" && url.pathname === "/deploy/v1/deployments") {
        const authorized = req.headers.authorization === `Bearer ${DEPLOY_TOKEN}`;
        res.writeHead(authorized ? 201 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(authorized
          ? { id: "dpl_7Qx2", url: "https://bellavista-clone.fixture.app", state: "READY" }
          : { error: "invalid token" }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** Requests recorded since `since` (a requests.length mark). */
    since: (mark) => requests.slice(mark),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const DEPLOY_TOKEN = "fxdeploy_4f9c1e7a2b8d";
