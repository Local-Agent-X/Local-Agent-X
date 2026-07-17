import * as playwright from "playwright";
import { spawn } from "node:child_process";
import { createServer as createPortProbe } from "node:net";
import { createServer as createProxyServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launchViaCDP } from "../../src/browser/launcher.ts";
import { killProcessTree } from "../../src/process-tree-kill.ts";

const [, , executablePath, downloadsPath, userDataDir, mode] = process.argv;
const portProbe = createPortProbe();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const address = portProbe.address();
if (!address || typeof address === "string") throw new Error("CDP test port did not bind");
const cdpPort = address.port;
await new Promise((resolve) => portProbe.close(resolve));

async function stopBrowserProcess(browser, chromeProcess) {
  await browser?.close().catch(() => {});
  killProcessTree(chromeProcess, "SIGKILL");
  if (chromeProcess && chromeProcess.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => chromeProcess.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

if (mode === "--probe") {
  const chromeProcess = spawn(executablePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });
  let spawnError;
  chromeProcess.once("error", (error) => { spawnError = error; });
  let browser;
  let probe = { available: false, reason: "browser process did not expose a CDP endpoint" };
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      if (spawnError || chromeProcess.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (spawnError) {
      if (!["EACCES", "EPERM"].includes(spawnError.code)) throw spawnError;
      probe = { available: false, reason: `browser process start denied (${spawnError.code})` };
    } else if (ready) {
      try {
        browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        const context = browser.contexts()[0];
        if (!context) throw new Error("CDP exposed no default browser context");
        const page = await context.newPage();
        await page.close();
        probe = { available: true, reason: "" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Target page, context or browser has been closed|ECONNREFUSED|CDP exposed no default browser context/i.test(message)) throw error;
        probe = { available: false, reason: `browser context unavailable (${message.split("\n")[0]})` };
      }
    } else if (chromeProcess.exitCode !== null) {
      probe = { available: false, reason: `browser process exited before CDP startup (code ${chromeProcess.exitCode})` };
    }
  } finally {
    await stopBrowserProcess(browser, chromeProcess);
  }
  process.stdout.write(`NATIVE_PROBE=${JSON.stringify(probe)}\n`);
  process.exit(0);
}

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
  forceProfileLaunch: true,
  removeProfileOnCleanup: true,
  readyAttempts: 50,
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
  await launched.cleanup?.();
  await new Promise((resolve) => proxy.close(resolve));
}
process.exit(0);
