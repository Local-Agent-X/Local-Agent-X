/**
 * Vendor skill packs that ship with LAX: official Agent Skills from the
 * platforms people build on (Supabase, Stripe, Firebase, Cloudflare, Neon,
 * Google Cloud, AWS, Vercel), vendored byte for byte under
 * src/protocols/bundled/vendor/<vendor>/<skill>/ at a pinned commit, with the
 * repo's LICENSE (and NOTICE) beside them and a LAX-side pack.json:
 *
 *   { vendor, repo, commit, license, docs, cli: [...], skills: { <folder>: { name, path, projectMarkers? } } }
 *
 * Unlike the bundled methodologies (general, never nudged — they matched almost
 * every coding request), a vendor skill is specific, so it is nudged like a
 * skill the user installed: origin "vendor", suggestion tier 2. The eval's
 * skills cases measured that path with stand-ins; these are the real packs.
 * pack.json carries the project markers upstream frontmatter never has, and the
 * docs URL + CLI names the stale-skill hint uses when a command fails.
 *
 * LAX_DISABLED_SKILL_PACKS=vercel,supabase leaves packs out (the eval's
 * no-skill arms).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Protocol } from "./types.js";
import { parseSkillMd } from "./skill-md-parser.js";
import { bundledProtocolsDir } from "./loader.js";

export interface VendorPack {
  vendor: string;
  repo: string;
  commit: string;
  pinnedAt: string;
  license: string;
  docs: string;
  cli: string[];
  platformTerms: string[];
  /** license/attribution override the pack's for a skill LAX wrote itself. */
  skills: Record<string, { name: string; path: string; projectMarkers?: string[]; license?: string; attribution?: string }>;
}

export function vendorPacksDir(): string {
  return join(bundledProtocolsDir(), "vendor");
}

function disabledPacks(): Set<string> {
  return new Set((process.env.LAX_DISABLED_SKILL_PACKS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

let packsCache: VendorPack[] | null = null;
let protocolsCache: Protocol[] | null = null;

/** Every shipped pack's metadata, disabled ones included. */
export function vendorPacks(): VendorPack[] {
  if (packsCache) return packsCache;
  const root = vendorPacksDir();
  if (!existsSync(root)) return (packsCache = []);
  packsCache = readdirSync(root)
    .map((vendor) => join(root, vendor, "pack.json"))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as VendorPack);
  return packsCache;
}

/** The enabled packs' skills as protocols. Static files, so read once. */
export function loadVendorProtocols(): Protocol[] {
  if (protocolsCache) return protocolsCache;
  const off = disabledPacks();
  const out: Protocol[] = [];
  for (const pack of vendorPacks()) {
    if (off.has(pack.vendor)) continue;
    for (const [folder, skill] of Object.entries(pack.skills)) {
      const sourcePath = join(vendorPacksDir(), pack.vendor, folder, "SKILL.md");
      if (!existsSync(sourcePath)) continue;
      const protocol = parseSkillMd(readFileSync(sourcePath, "utf8"), {
        source: {
          type: "bundled",
          origin: "vendor",
          sourcePath,
          repo: pack.repo,
          commit: pack.commit,
          license: skill.license ?? pack.license,
          platformTerms: pack.platformTerms,
          attribution: skill.attribution ?? `${pack.vendor} — ${pack.repo} @ ${pack.commit.slice(0, 12)} (${pack.license})`,
        },
        fallbackName: skill.name,
      });
      if (!protocol) continue;
      out.push(skill.projectMarkers ? { ...protocol, projectMarkers: skill.projectMarkers } : protocol);
    }
  }
  return (protocolsCache = out);
}

/** The pack whose CLI a command runs, e.g. `npx wrangler deploy` → cloudflare. */
export function vendorPackForCommand(command: string): VendorPack | null {
  const words = command.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
  const first = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "");
  const program = ["npx", "pnpx", "bunx", "yarn", "pnpm"].includes(first) ? (words[1] ?? "") : first;
  if (!program) return null;
  return vendorPacks().find((p) => p.cli.includes(program)) ?? null;
}

/** Test seam. */
export function _resetVendorPacksCache(): void {
  packsCache = null;
  protocolsCache = null;
}
