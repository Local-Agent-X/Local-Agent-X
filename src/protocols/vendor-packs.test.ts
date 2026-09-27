// The vendor skill packs that ship with LAX load as protocols, keep their
// provenance, and are NUDGED — the eval's skills cases measured that path with
// hand-written stand-ins, and it only helps users if the real packs take it.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadVendorProtocols, vendorPacks, vendorPackForCommand, vendorPacksDir, _resetVendorPacksCache } from "./vendor-packs.js";
import { selectLearnedProtocolSuggestion } from "./learned-suggestion.js";
import type { Protocol } from "./types.js";

afterEach(() => { delete process.env.LAX_DISABLED_SKILL_PACKS; _resetVendorPacksCache(); });

const noRecord = () => { throw new Error("no learned records here"); };
const suggest = (message: string, protocols: Protocol[], markerHit?: (p: Protocol) => boolean) =>
  selectLearnedProtocolSuggestion(message, [], protocols, noRecord as never, markerHit ? { projectMarkerHit: markerHit } : {})?.name ?? null;

describe("shipped vendor packs", () => {
  it("every pack carries its license file, a pinned commit, a docs URL and its CLI names", () => {
    const packs = vendorPacks();
    expect(packs.map((p) => p.vendor).sort()).toEqual(["aws", "cloudflare", "firebase", "google", "neon", "stripe", "supabase", "vercel"]);
    for (const p of packs) {
      expect(p.commit, p.vendor).toMatch(/^[0-9a-f]{40}$/);
      expect(["MIT", "Apache-2.0"], p.vendor).toContain(p.license);
      expect(p.docs, p.vendor).toMatch(/^https:\/\//);
      expect(p.cli.length, p.vendor).toBeGreaterThan(0);
      expect(existsSync(join(vendorPacksDir(), p.vendor, "LICENSE")), `${p.vendor} LICENSE`).toBe(true);
      expect(p.pinnedAt, p.vendor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every skill loads with its real description — none is the literal '>-' the old parser produced", () => {
    const skills = loadVendorProtocols();
    expect(skills.length).toBeGreaterThanOrEqual(30);
    for (const s of skills) {
      expect(s.source?.origin, s.name).toBe("vendor");
      expect(s.description.length, s.name).toBeGreaterThan(40);
      expect(s.description, s.name).not.toMatch(/^[>|][+-]?$/);
      expect(s.body?.length ?? 0, s.name).toBeGreaterThan(200);
      expect(readFileSync(s.source!.sourcePath!, "utf8").length, s.name).toBeLessThan(26_000);
    }
  });

  it("a request in the platform's words is nudged to that platform's skill", () => {
    const skills = loadVendorProtocols();
    expect(suggest("deploy this worker to cloudflare with wrangler and fix the wrangler config", skills)).toMatch(/wrangler|workers|cloudflare/);
    expect(suggest("set up firebase authentication with google sign-in for my web app", skills)).toMatch(/firebase-auth/);
    expect(suggest("add stripe subscriptions billing to the checkout with stripe best practices", skills)).toMatch(/stripe/);
  });

  it("a project marker makes the project's platform win, even when the wording never names it", () => {
    const skills = loadVendorProtocols();
    const vendorOf = (name: string | null) => skills.find((s) => s.name === name)?.source?.sourcePath?.split(/[\\/]/).at(-3);
    const wranglerProject = (p: Protocol) => (p.projectMarkers ?? []).includes("wrangler.toml");
    // Without the marker, generic words picked another platform's skill.
    expect(vendorOf(suggest("the deploy is failing on this project, can you fix the deployment config", skills, wranglerProject))).toBe("cloudflare");
    const firebaseProject = (p: Protocol) => (p.projectMarkers ?? []).includes("firebase.json");
    expect(vendorOf(suggest("the deploy is failing on this project, can you fix the deployment config", skills, firebaseProject))).toBe("firebase");
  });

  it("a request that never names a platform, outside any platform's project, nudges no vendor skill", () => {
    const skills = loadVendorProtocols();
    expect(suggest("read write bash release files", skills)).toBeNull();
    expect(suggest("read the config file, write the summary and run the tests", skills)).toBeNull();
    expect(suggest("add authentication to the login page and store sessions", skills)).toBeNull();
  });

  it("a disabled pack is left out (the eval's no-skill arms)", () => {
    process.env.LAX_DISABLED_SKILL_PACKS = "cloudflare, stripe";
    _resetVendorPacksCache();
    const vendors = new Set(loadVendorProtocols().map((s) => dirname(dirname(s.source!.sourcePath!)).split(/[\\/]/).pop()));
    expect(vendors.has("cloudflare")).toBe(false);
    expect(vendors.has("stripe")).toBe(false);
    expect(vendors.has("supabase")).toBe(true);
  });

  it("a command is traced to the pack whose CLI it runs", () => {
    expect(vendorPackForCommand("npx wrangler deploy --env production")?.vendor).toBe("cloudflare");
    expect(vendorPackForCommand("FOO=1 firebase deploy --only hosting")?.vendor).toBe("firebase");
    expect(vendorPackForCommand("C:\\tools\\gcloud.cmd run deploy api")?.vendor).toBe("google");
    expect(vendorPackForCommand("npm run build")).toBeNull();
  });
});
