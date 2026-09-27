// A failed vendor CLI command says the skill may be stale and names the
// cheapest current source first; each firing is logged for the pack review.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-vendor-drift-"));
const { vendorDriftHint, vendorDriftLogPath } = await import("./vendor-drift.js");

describe("vendorDriftHint", () => {
  it("a failed wrangler command points at wrangler's own --help, then Cloudflare's docs, and is logged", () => {
    const hint = vendorDriftHint("npx wrangler deploy --legacy-env", 1, "✘ [ERROR] Unknown argument: legacy-env\nmore");
    expect(hint).toContain("cloudflare skill");
    expect(hint).toContain("`wrangler deploy --help`");
    expect(hint).toContain("https://developers.cloudflare.com");
    expect(hint).toMatch(/pinned to \d{4}-\d{2}-\d{2}/);
    const logged = readFileSync(vendorDriftLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    expect(logged).toMatchObject({ vendor: "cloudflare", program: "wrangler", sub: "deploy", exitCode: 1, stderr: "✘ [ERROR] Unknown argument: legacy-env" });
  });

  it("the logged stderr line has secrets redacted", () => {
    vendorDriftHint("vercel deploy --yes", 1, "Error: token sbp_0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c rejected");
    const last = readFileSync(vendorDriftLogPath(), "utf8").trim().split("\n").at(-1)!;
    expect(last).not.toContain("sbp_0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c");
  });

  it("stays quiet on success, on a CLI that is not installed, and on a program no pack owns", () => {
    expect(vendorDriftHint("wrangler deploy", 0, "")).toBeNull();
    expect(vendorDriftHint("wrangler deploy", 127, "bash: wrangler: command not found")).toBeNull();
    expect(vendorDriftHint("firebase deploy", 1, "'firebase' is not recognized as an internal or external command")).toBeNull();
    expect(vendorDriftHint("npm run build", 1, "error")).toBeNull();
    expect(existsSync(vendorDriftLogPath())).toBe(true);
  });
});
