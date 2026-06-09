import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { rmSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, setRuntimeConfig } from "../config.js";
import { extractSiteAssetsTool } from "./asset-tools.js";

// R4-16 regression suite. extract_site_assets used to run its OWN weak SSRF
// check (dnsPinUrl — ALLOWED any literal IP) and a plain redirect:"follow"
// fetch, so an attacker page embedding <img src="http://169.254.169.254/...">
// (or a public URL 302→metadata IP) reached the cloud-metadata endpoint. All
// fetches now route through canonicalFetch (per-hop literal-IP + DNS-pin +
// scheme check, fail-closed), so every private/loopback/metadata destination is
// blocked pre-connect. These tests assert the metadata IP is NEVER fetched.

const METADATA_IP = "169.254.169.254";

let server: Server;
let port: number;
let outDir: string;
// HTML the loopback test page serves: a SECONDARY <img> candidate pointing at
// the cloud-metadata IP, plus a public-looking URL that 302s to a private host.
let pageHtml = "";
let redirectTarget = "";

function listen(s: Server): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => {
      resolve((s.address() as { port: number }).port);
    });
  });
}

beforeAll(async () => {
  // A loopback page server. extract_site_assets' top-level fetch is allowed to
  // reach it only because we register its port as the runtime self-port below
  // (canonicalFetch recognises 127.0.0.1:<self-port> as a self-call). The
  // HARVESTED candidate it embeds is the metadata IP, which must still be blocked.
  server = createServer((req, res) => {
    if (req.url === "/redirect-to-private") {
      res.writeHead(302, { Location: redirectTarget });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(pageHtml);
  });
  port = await listen(server);
  redirectTarget = `http://${METADATA_IP}/role.png`;
  pageHtml =
    `<html><body>` +
    `<img src="http://${METADATA_IP}/role.png">` +
    `<img src="http://127.0.0.1:1/loopback.png">` +
    `</body></html>`;

  // Make the loopback page server a recognised self-call so the TOP-LEVEL fetch
  // is permitted while the harvested literal-IP candidates stay blocked.
  const cfg = loadConfig();
  cfg.port = port;
  setRuntimeConfig(cfg);

  outDir = join(process.cwd(), `.asset-tools-test-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
});

afterAll(() => {
  try { server.close(); } catch { /* best-effort */ }
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("extract_site_assets SSRF gate (R4-16)", () => {
  it("does NOT fetch a harvested secondary candidate pointing at the metadata IP", async () => {
    const out = await extractSiteAssetsTool.execute({
      url: `http://127.0.0.1:${port}/`,
      output_dir: outDir,
    });
    // The metadata image must never have been downloaded to disk.
    const files = readdirSync(outDir);
    expect(files.length).toBe(0);
    // It is surfaced as a per-asset skip, not a silent success or a crash.
    const manifest = (out as { metadata?: { manifest?: { errors?: Array<{ url: string; error: string }> } } }).metadata?.manifest;
    const text = (out as { content?: string }).content ?? "";
    const reported = manifest
      ? manifest.errors ?? []
      : [];
    // Either it routed to the "0 downloaded" err result (content lists errors)
    // or to a manifest with the blocked candidates in errors[].
    const sawMetadata =
      reported.some((e) => e.url.includes(METADATA_IP)) || text.includes(METADATA_IP);
    expect(sawMetadata).toBe(true);
  });

  it("blocks a top-level URL that is itself the metadata IP (never fetched)", async () => {
    const out = await extractSiteAssetsTool.execute({
      url: `http://${METADATA_IP}/`,
      output_dir: outDir,
    });
    // Top-level fetch is gated → tool returns an error result, no images.
    expect((out as { isError?: boolean }).isError).toBe(true);
    const text = (out as { content?: string }).content ?? "";
    expect(text).toMatch(/Failed to fetch source/i);
  });

  it("does NOT follow a 302 from the page server to a private host", async () => {
    const out = await extractSiteAssetsTool.execute({
      url: `http://127.0.0.1:${port}/redirect-to-private`,
      output_dir: outDir,
    });
    // The 302 → 169.254.169.254 is re-validated per hop and fails closed, so the
    // page fetch never lands a body; the tool reports a fetch failure.
    expect((out as { isError?: boolean }).isError).toBe(true);
    const text = (out as { content?: string }).content ?? "";
    expect(text).toMatch(/Failed to fetch source/i);
    expect(readdirSync(outDir).length).toBe(0);
  });
});
