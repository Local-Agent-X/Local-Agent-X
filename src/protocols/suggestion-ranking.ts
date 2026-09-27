/**
 * The final pick among admitted protocol suggestions (learned-suggestion.ts
 * scores and admits; this chooses).
 */
import type { Protocol } from "./types.js";

export interface RankedSuggestion {
  protocol: Protocol;
  score: number;
  name: { hits: number; misses: number };
  tier: number;
  markerHit: boolean;
}

/** The platform a skill's name leads with: `vercel`-deploy, `firebase`-basics. */
const platformOf = (name: string): string => name.toLowerCase().split(/[-_]/)[0];

export function pickBestSuggestion(ranked: RankedSuggestion[], messageTerms: ReadonlySet<string>): RankedSuggestion | undefined {
  // Once a project marker says which platform this project is, a skill that
  // declares markers for a DIFFERENT platform is out unless the message names
  // that platform: in a Cloudflare project, "the deploy is failing, fix the
  // config" ranked firebase-basics first on generic words — and a shared verb
  // ("deploy" in vercel-deploy) is not naming it.
  const projectKnown = ranked.some((r) => r.markerHit);
  const eligible = projectKnown
    ? ranked.filter((r) => r.markerHit || !r.protocol.projectMarkers?.length || messageTerms.has(platformOf(r.protocol.name)))
    : [...ranked];
  // A tie is a RANKING problem, not a reason to say nothing. Suppressing on a
  // tie meant the more protocols the authoring fork wrote, the less retrieval
  // worked — near-duplicates (`po_intake` / `po_intake_v2`) silenced each other
  // permanently, and any custom record could silence a verified learned one.
  // Resolve deterministically instead: score, tier, name hits, name misses,
  // then alphabetical. The two name keys sit ahead of the alphabetical
  // fallback so a tie does not systematically go to whichever name sorts
  // first, and they are absolute rather than normalized so it does not go to
  // whichever name is shortest either.
  eligible.sort((a, b) =>
    b.score - a.score
    || a.tier - b.tier
    || b.name.hits - a.name.hits
    || a.name.misses - b.name.misses
    || a.protocol.name.localeCompare(b.protocol.name));
  return eligible[0];
}
