import * as playwright from "playwright";
import { createServer as createPortProbe } from "node:net";
import { createServer as createProxyServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launchViaCDP } from "../../src/browser/launcher.ts";

const [, , executablePath, downloadsPath, userDataDir] = process.argv;
const portProbe = createPortProbe();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const address = portProbe.address();
if (!address || typeof address === "string") throw new Error("CDP test port did not bind");
const cdpPort = address.port;
await new Promise((resolve) => portProbe.close(resolve));

const proxy = createProxyServer((request, response) => {
  if (request.url?.includes("download.test/review.txt")) {
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Disposition": "attachment; filename=review.txt",
    });
    response.end("reviewer-reproduction");
    return;
  }
  response.writeHead(204);
  response.end();
});
proxy.on("connect", (_request, socket) => socket.destroy());
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyAddress = proxy.address();
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("test proxy did not bind");

const launched = await launchViaCDP(playwright, `http://127.0.0.1:${proxyAddress.port}`, {
  executablePath,
  cdpPort,
  userDataDir,
  downloadsDir: downloadsPath,
  headless: true,
});

try {
  if (!launched.chromeProcess) throw new Error("production launcher fell back instead of connecting over CDP");
  const context = launched.browser.contexts()[0];
  if (!context) throw new Error("CDP launcher exposed no default browser context");
  const page = await context.newPage();
  await page.setContent(`<a id="download" href="http://download.test/review.txt">download</a>`);
  let downloadSeen = false;
  page.on("download", () => { downloadSeen = true; });
  await page.click("#download");
  let nativePath = "";
  for (let i = 0; i < 50; i++) {
    const file = readdirSync(downloadsPath).find((name) => !name.endsWith(".crdownload"));
    if (file) {
      nativePath = join(downloadsPath, file);
      if (existsSync(nativePath)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stdout.write(`NATIVE_RESULT=${JSON.stringify({ nativePath, existed: existsSync(nativePath), usedCdp: true, downloadSeen })}\n`);
  await page.close();
} finally {
  await launched.browser.close().catch(() => {});
  try { launched.chromeProcess?.kill(); } catch {}
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));
}
process.exit(0);
