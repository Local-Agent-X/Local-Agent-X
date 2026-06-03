// Read model over the three personality files (IDENTITY/HEART/USER) for the
// Core node — the agent's "ID card / dossier" in the Memory tab. Reads through
// readPersonalityFile so the comment-strip and taint check apply; this module
// only parses the already-trusted markdown into display fields. The card is a
// live view: naming the agent or editing the files reshapes it on next read.

import { statSync } from "node:fs";
import { join } from "node:path";
import { readPersonalityFile, PERSONALITY_FILES } from "./personality.js";
import { findContradictions } from "./contradiction-sweep.js";

export interface IdentityProfile {
  named: boolean;
  identity: { name: string; emoji: string; tagline: string; vibe: string; portrait: string };
  heart: { orders: string[]; boundaries: string[] };
  user: { fields: Array<{ label: string; value: string }> };
  lastAmended: number | null; // ms epoch of the most-recently-edited profile file
  contradictions: number; // self-conflicting standing-order/restriction pairs
}

// "maria-lopez" → "Maria Lopez". Entity slugs are lowercase-hyphenated; this
// restores a display name for the network chips.
export function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const DEFAULT_PORTRAIT = "/agent-x-portrait.png";

// "- Field: value" → Map(field → value). Same SCALAR shape personality.ts
// writes, read back the same way.
function parseScalars(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of md.split("\n")) {
    const m = line.match(/^-\s+([^:\n]+?):\s*(.*)$/);
    if (m) out.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  return out;
}

// Prose bullets ("- text"), skipping scalar "- Field: value" lines. Routes
// bullets under a boundary/restriction "## Section" into `boundaries`.
function parseBullets(md: string): { orders: string[]; boundaries: string[] } {
  const orders: string[] = [];
  const boundaries: string[] = [];
  let inBoundaries = false;
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) { inBoundaries = /boundar|restrict|never|don'?t/i.test(h[1]); continue; }
    const b = line.match(/^-\s+(.+?)\s*$/);
    if (!b) continue;
    if (/^[^:]{1,40}:/.test(b[1])) continue; // scalar field, not a prose rule
    (inBoundaries ? boundaries : orders).push(b[1]);
  }
  return { orders, boundaries };
}

const NOT_NAMED = /not yet named/i;

export async function readIdentityProfile(memDir: string): Promise<IdentityProfile> {
  const identityMd = (await readPersonalityFile(memDir, "identity")) || "";
  const heartMd = (await readPersonalityFile(memDir, "heart")) || "";
  const userMd = (await readPersonalityFile(memDir, "user")) || "";

  const id = parseScalars(identityMd);
  const rawName = id.get("name") || "";
  const named = !!rawName && !NOT_NAMED.test(rawName);

  // Drop empty values, the pronoun field, and unfilled template placeholders
  // ("(casual / formal / technical / etc.)") so the handler section only shows
  // real, declared facts.
  const userFields = [...parseScalars(userMd).entries()]
    .filter(([k, v]) => v && !/pronoun/i.test(k) && !/^\(.*\)$/.test(v))
    .map(([k, v]) => ({ label: k.replace(/\b\w/g, (c) => c.toUpperCase()), value: v }));

  const heart = parseBullets(heartMd);
  const rules = [...heart.orders, ...heart.boundaries].map((text, i) => ({ text, payload: i }));

  return {
    named,
    identity: {
      name: named ? rawName : "",
      emoji: id.get("emoji") || "",
      tagline: id.get("tagline") || "",
      vibe: id.get("vibe") || "",
      portrait: id.get("portrait") || DEFAULT_PORTRAIT,
    },
    heart,
    user: { fields: userFields },
    lastAmended: latestMtime(memDir),
    contradictions: findContradictions(rules).length,
  };
}

function latestMtime(memDir: string): number | null {
  let latest = 0;
  for (const file of Object.values(PERSONALITY_FILES)) {
    try { latest = Math.max(latest, statSync(join(memDir, file)).mtimeMs); } catch {}
  }
  return latest || null;
}
