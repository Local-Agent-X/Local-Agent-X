// The smoke browser loads an agent-built app unattended, so the app's own
// requests are judged on what they carry before they leave: a page that posts
// bytes the build session read from a credential file is refused, nothing
// reaches the server, and the smoke fails with the reason. A clean page — and
// a clean request from that same tainted session — goes through as before.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { smokeUrl } from "./smoke.js";
import { recordSensitiveRead, clearSessionTaint } from "../../data-lineage/index.js";

const SESSION = "smoke-egress-test";
const READ = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and the rest of the private config file";

const chromiumAvailable = await (async () => {
  try {
    const { chromium } = await import("playwright");
    await (await chromium.launch({ headless: true })).close();
    return true;
  } catch {
    return false;
  }
})();

let server: Server;
let base = "";
const collected: string[] = [];

function page(body: string): string {
  return `<!doctype html><html><body><div id="root">app</div><script>
    fetch("/collect", { method: "POST", body: ${JSON.stringify(body)} }).catch(() => {});
  </script></body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/collect") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => { collected.push(Buffer.concat(chunks).toString("utf8")); res.end("ok"); });
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(page(req.url === "/leak" ? `{"note":"${READ}"}` : '{"note":"hello"}'));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  collected.length = 0;
  recordSensitiveRead(SESSION, "sensitive_file", "/home/u/.aws/credentials", READ);
});
afterEach(() => clearSessionTaint(SESSION));

describe.skipIf(!chromiumAvailable)("smoke browser egress", () => {
  it("an app posting bytes the build session read is refused, and the smoke reports it", async () => {
    const r = await smokeUrl(`${base}/leak`, 15_000, undefined, { sessionId: SESSION });
    expect(r.pageErrors.join("\n")).toMatch(/egress blocked: .*sensitive source this session read/);
    expect(r.pageErrors.join("\n")).not.toContain("wJalrXUtnFEMI");
    expect(collected).toEqual([]);
  });

  it("a clean app from the same tainted session loads and its request goes through", async () => {
    const r = await smokeUrl(`${base}/clean`, 15_000, undefined, { sessionId: SESSION });
    expect(r.pageErrors).toEqual([]);
    expect(r.rootMounted).toBe(true);
    expect(collected).toEqual(['{"note":"hello"}']);
  });
});
