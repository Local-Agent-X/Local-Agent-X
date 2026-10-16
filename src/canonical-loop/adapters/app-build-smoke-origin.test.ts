/**
 * The build gate's origin serves the bundled design-system faces where
 * production does, so a page that loads its face renders the same in the gate
 * as for the user, and other paths outside the app's mount stay refused.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticSmokeOrigin, type SmokeOrigin } from "./app-build-smoke-origin.js";

let root: string;
let origin: SmokeOrigin | null = null;

afterEach(async () => {
  await origin?.close();
  origin = null;
  rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "smoke-origin-"));
  const appDir = join(root, "apps", "demo");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "index.html"), "<!doctype html><title>demo</title>");
  origin = await startStaticSmokeOrigin(appDir);
  return new URL(origin.url).origin;
}

describe("app_build smoke origin — bundled faces", () => {
  it("serves a face's stylesheet and font file beside the app", async () => {
    const base = await start();
    const css = await fetch(`${base}/vendor/fonts/manrope.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css");
    const file = (await css.text()).match(/url\(\.\/([^)]+)\)/)?.[1];
    const font = await fetch(`${base}/vendor/fonts/${file}`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
  });

  it("still refuses everything else outside the app's mount", async () => {
    const base = await start();
    expect((await fetch(`${base}/vendor/katex/katex.min.css`)).status).toBe(404);
    expect((await fetch(`${base}/apps/demo/`)).status).toBe(200);
  });
});
