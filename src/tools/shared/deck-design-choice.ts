/**
 * Which curated design a deck is made in (office-designs.ts). The agent
 * names one that fits the audience and purpose. When it names none, the deck
 * gets a general-purpose design not used recently, so two unnamed decks do
 * not come out identical, and the result says so the agent can choose next
 * time. A slide added to an existing deck takes the last design used, which
 * is the deck it extends.
 *
 * The recent designs are a small list in the data folder, nothing more.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { OFFICE_DESIGNS, OFFICE_DESIGN_NAMES, isOfficeDesignName, type OfficeDesignName } from "./office-designs.js";

/** Designs that suit most audiences: the ones a deck gets when none is
 *  named. The specialist ones (legal, kids, hospitality, creative, launch)
 *  are only ever chosen on purpose. */
export const GENERAL_DESIGNS: readonly OfficeDesignName[] = ["midnight", "harbor", "evergreen", "ember", "graphite"];

const RECENT_KEPT = 10;
const recentFile = () => join(getLaxDir(), "deck-designs.json");

function readRecent(): OfficeDesignName[] {
  try {
    if (!existsSync(recentFile())) return [];
    const list = JSON.parse(readFileSync(recentFile(), "utf8")) as unknown;
    return Array.isArray(list) ? list.filter(isOfficeDesignName) : [];
  } catch {
    return []; // an unreadable list only costs the rotation its memory
  }
}

/** Remember a deck's design, newest first. */
export function noteDeckDesign(name: OfficeDesignName): void {
  try {
    const recent = [name, ...readRecent().filter((n) => n !== name)].slice(0, RECENT_KEPT);
    mkdirSync(getLaxDir(), { recursive: true });
    writeFileSync(recentFile(), JSON.stringify(recent));
  } catch { /* the deck is already written; failing to remember its design never fails it */ }
}

export interface DeckDesignChoice {
  name: OfficeDesignName;
  /** Who chose: the agent named it, it continues the last deck, or the
   *  rotation picked it because none was named. */
  by: "named" | "continued" | "rotation";
}

/** The design for a new deck, or (`extending`) for a slide joining the last one. */
export function chooseDeckDesign(requested: unknown, extending = false): DeckDesignChoice {
  if (isOfficeDesignName(requested)) return { name: requested, by: "named" };
  const recent = readRecent();
  if (extending && recent[0]) return { name: recent[0], by: "continued" };
  const unused = GENERAL_DESIGNS.find((n) => !recent.includes(n));
  const oldest = [...GENERAL_DESIGNS].sort((a, b) => recent.indexOf(b) - recent.indexOf(a))[0];
  return { name: unused ?? oldest, by: "rotation" };
}

/** The line the result carries about the design. */
export function designNote(choice: DeckDesignChoice, requested: unknown): string {
  if (choice.by === "named") return `Design: ${choice.name}.`;
  const asked = requested ? ` ("${String(requested)}" is not a design)` : "";
  if (choice.by === "continued") return `Design: ${choice.name}, the last deck's${asked}.`;
  return `Design: ${choice.name}: no design was named${asked}, so one not used recently was picked. ` +
    "Name the design that fits the audience and purpose (see the design parameter).";
}

/** The `design` parameter's description: every design and what it suits. */
export const DESIGN_PARAM_SCHEMA = {
  type: "string",
  enum: OFFICE_DESIGN_NAMES,
  description:
    "The deck's design: choose the one that fits who it is for and what it is about, not the same one every time. " +
    OFFICE_DESIGN_NAMES.map((n) => `${n}: ${OFFICE_DESIGNS[n].suits}`).join("; ") + ".",
} as const;
