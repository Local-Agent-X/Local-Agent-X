import { chromium } from "playwright";
import { createServer } from "node:http";
import { existsSync } from "node:fs";

const [, , executablePath, downloadsPath, userDataDir] = process.argv;
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  downloadsPath,
  args: ["--disable-breakpad", "--disable-crash-reporter"],
});
const server = createServer((_request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/plain",
    "Content-Disposition": "attachment; filename=review.txt",
  });
  response.end("reviewer-reproduction");
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test download server did not bind");
  const page = await context.newPage();
  await page.setContent(`<a id="download" href="http://127.0.0.1:${address.port}/review.txt">download</a>`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  const nativePath = await download.path();
  process.stdout.write(JSON.stringify({ nativePath, existed: Boolean(nativePath && existsSync(nativePath)) }));
  await download.delete();
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
