/**
 * What a deck is for, and the rules that follow from it. A pitch, a legal
 * briefing and a kids' lesson need different decks: how much text a slide
 * may carry, how small type may get, which designs suit it.
 *
 * Two halves, kept where each can be held to account:
 *   - The measurable rules live here, and the deck check enforces them
 *     (slide-checks.ts): words and bullets per slide, the smallest text.
 *   - The judgment rules (story, tone, imagery, what to leave out) are a
 *     playbook per purpose, a SKILL.md in the skills system
 *     (src/protocols/bundled/deck-<purpose>/), which the user can override by
 *     dropping their own deck-<purpose> into workspace/protocols/imported/.
 *     The deck tool hands the agent the playbook with its rendered slides.
 *
 * Projected decks carry about 40 words a slide, decks read alone 150–200
 * (Duarte's distinction, the main split professional guidance makes); the
 * legal and kids rules are this project's own judgment, since no source
 * found covers them (reports/research, 2026-11-23).
 */
import type { OfficeDesignName } from "./office-designs.js";

export interface DeckPurpose {
  /** What it is, for the parameter description. */
  is: string;
  maxWords: number;
  maxBullets: number;
  /** Smallest body text the audience can read, in points. */
  minTextPt: number;
  /** Designs that suit it, best first. */
  designs: readonly OfficeDesignName[];
}

export const DECK_PURPOSES = {
  pitch: { is: "raising money or selling a vision to investors", maxWords: 40, maxBullets: 4, minTextPt: 18, designs: ["midnight", "signal", "harbor"] },
  sales: { is: "a customer or prospect deciding to buy", maxWords: 50, maxBullets: 5, minTextPt: 16, designs: ["ember", "harbor", "midnight"] },
  update: { is: "an internal team or board status update", maxWords: 70, maxBullets: 6, minTextPt: 14, designs: ["graphite", "harbor", "midnight"] },
  training: { is: "teaching a skill or process to staff or students", maxWords: 55, maxBullets: 5, minTextPt: 18, designs: ["harbor", "sunny", "evergreen"] },
  report: { is: "a leave-behind read alone, not presented", maxWords: 170, maxBullets: 8, minTextPt: 12, designs: ["graphite", "midnight", "ivory"] },
  legal: { is: "legal, compliance, policy or governance", maxWords: 130, maxBullets: 8, minTextPt: 12, designs: ["ledger", "graphite"] },
  kids: { is: "children: a lesson, story or class activity", maxWords: 20, maxBullets: 3, minTextPt: 24, designs: ["sunny", "studio"] },
  promo: { is: "an event, product promotion or announcement", maxWords: 30, maxBullets: 4, minTextPt: 20, designs: ["studio", "ember", "signal", "evergreen", "ivory"] },
} as const satisfies Record<string, DeckPurpose>;

export type DeckPurposeName = keyof typeof DECK_PURPOSES;
export const DECK_PURPOSE_NAMES = Object.keys(DECK_PURPOSES) as DeckPurposeName[];

export function isDeckPurpose(v: unknown): v is DeckPurposeName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DECK_PURPOSES, v);
}

/** The limits the deck check applies: the purpose's, or general ones. */
export interface DeckLimits { maxWords: number; maxBullets: number; minTextPt?: number; purpose?: DeckPurposeName }

export function deckLimits(purpose: unknown): DeckLimits {
  if (!isDeckPurpose(purpose)) return { maxWords: 75, maxBullets: 6 };
  const p = DECK_PURPOSES[purpose];
  return { maxWords: p.maxWords, maxBullets: p.maxBullets, minTextPt: p.minTextPt, purpose };
}

/** The protocol holding a purpose's playbook. */
export const playbookName = (purpose: DeckPurposeName) => `deck-${purpose}`;

/** The purpose's playbook text, from the skills system (a user's own
 *  deck-<purpose> wins over the bundled one), or null when there is none. */
export async function loadPlaybook(purpose: DeckPurposeName): Promise<string | null> {
  try {
    // Imported when needed: the skills catalog pulls in tool modules itself.
    const { getAllProtocols } = await import("../../protocols/index.js");
    const p = getAllProtocols().find((x) => x.name === playbookName(purpose));
    return p?.body?.trim() || null;
  } catch {
    return null; // the deck is written either way; only the review loses its rules
  }
}

/** The `purpose` parameter's description. */
export const PURPOSE_PARAM_SCHEMA = {
  type: "string",
  enum: DECK_PURPOSE_NAMES,
  description:
    "What the deck is for; sets its rules (text per slide, smallest type) and the playbook you review it against. " +
    DECK_PURPOSE_NAMES.map((n) => `${n}: ${DECK_PURPOSES[n].is} (designs: ${DECK_PURPOSES[n].designs.join("/")})`).join("; ") + ".",
} as const;
