/**
 * The figures in a deliverable, listed: what the figures check counts and
 * chooses from. The check used to let its verifier pick "3-7 load-bearing
 * values" whatever the file's size, so a 20-slide deck got the same spot check
 * as a 5-slide one and the note's "they match" could not say how much was
 * looked at (owner's call, 2026-11-24: scale the check with the deck, show the
 * count, let the rest be checked on request).
 *
 * A figure is a number a reader would quote: an amount, a share, a price, a
 * measured quantity. Dates, years, small counts ("the 5 cheapest states"),
 * list numbering and citation labels ("Table 5.6.A") are not. Each figure has
 * a stable id by its place (slide, section, row) and its order there, so a
 * corrected value keeps its id and "the rest" stays the same set.
 *
 * Read here: decks and Word documents (their text, as the `read` tool shows
 * it), markdown and CSV. Spreadsheets and PDFs return null: their figures are
 * not listed, and the check falls back to the verifier's own pick.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { extractOfficeText } from "../tools/office-text.js";

export interface Figure {
  /** Stable within its file: place key plus order there, e.g. "slide3#2". */
  id: string;
  /** Where a reader finds it: "Slide 3", "Row 12", a section heading. */
  where: string;
  /** The figure as written: "$0.42", "17.3%", "1,204 MWh". */
  value: string;
  /** The line it sits in, clipped: what the verifier searches for. */
  context: string;
}

export interface FileFigures {
  path: string;
  figures: Figure[];
}

const MONTHS = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
/** Taken out of a line before figures are matched: they hold digits that are not figures. */
const NOT_FIGURES = [
  /https?:\/\/\S+/gi,
  new RegExp(`\\b${MONTHS}\\.?\\s+\\d{4}\\b`, "gi"), // September 2026
  new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2}(?!\\d)(?:st|nd|rd|th)?(?:,\\s*\\d{4})?`, "gi"), // November 24, 2026
  new RegExp(`\\b\\d{1,2}\\s+${MONTHS}\\b`, "gi"), // 24 November
  /\b\d{4}-\d{2}-\d{2}\b/g, // 2026-11-24
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, // 11/24/2026
  /\b\d+(?:\.\d+)+\.?[A-Za-z]\b/g, // Table 5.6.A
  /^\s*\d+[.)]\s/g, // list numbering
];

/** A number with what makes it a figure around it: currency, a scale word, a unit or a percent. */
const FIGURE = /(?:[$€£¥]\s?)?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?:[$€£¥]\s?)?\d+(?:\.\d+)?/g;
/** What written right after a number makes it a measured figure (kept with it). */
const UNIT = /^\s?(?:%|percent\b|¢(?:\s?\/\s?[A-Za-z]+)?|cents?\b(?:\s?\/\s?[A-Za-z]+|\s+per\s+[A-Za-z]+)?|(?:bn|billion|million|thousand|trillion)\b|[kKMBT]\b|[kMGT]?Wh\b(?:\s?\/\s?[A-Za-z]+)?|[kMG]W\b|(?:USD|EUR|GBP)\b|(?:kg|lbs?|tons?|km|mi|mph|ft|cm|mm|°[CF])\b|x\b|×)/;
const SOURCE_LINE = /^\s*(?:sources?|notes?|citation|data)\s*:/i;
const SLIDE_HEADER = /^--- Slide (\d+) ---$/;
const HEADING = /^#{1,6}\s+(.+)$/;

function isFigure(raw: string, after: string): boolean {
  const hasCurrency = /^[$€£¥]/.test(raw);
  const digits = raw.replace(/^[$€£¥]\s?/, "");
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return false;
  const decorated = hasCurrency || UNIT.test(after);
  // A bare year is a date, not a figure.
  if (!decorated && /^(?:19|20)\d{2}$/.test(digits)) return false;
  // A small whole number with nothing around it is a count or an index.
  if (!decorated && !digits.includes(".") && !digits.includes(",") && n < 10) return false;
  return true;
}

/** The figures on one line, each with the unit or scale written after it. */
export function figuresInLine(line: string): string[] {
  if (SOURCE_LINE.test(line)) return [];
  let text = line;
  for (const pattern of NOT_FIGURES) text = text.replace(pattern, (m) => " ".repeat(m.length));
  const out: string[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const start = m.index ?? 0;
    // Part of a word or a longer token (an id, a model number): not a figure.
    if (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1])) continue;
    const after = text.slice(start + m[0].length);
    if (!isFigure(m[0], after)) continue;
    out.push(`${m[0]}${after.match(UNIT)?.[0] ?? ""}`.trim());
  }
  return out;
}

/** Text lines grouped by place: slides for a deck, headings for markdown, rows for CSV. */
function placesOf(path: string, text: string): Array<{ key: string; where: string; lines: string[] }> {
  const ext = extname(path).toLowerCase();
  const places: Array<{ key: string; where: string; lines: string[] }> = [];
  const lines = text.split(/\r?\n/);
  if (ext === ".csv") {
    return lines.map((l, i) => ({ key: `row${i + 1}`, where: `Row ${i + 1}`, lines: [l] })).filter((p) => p.lines[0].trim());
  }
  let place = { key: "top", where: ext === ".pptx" ? "Title" : "Opening", lines: [] as string[] };
  places.push(place);
  for (const line of lines) {
    const slide = ext === ".pptx" ? line.match(SLIDE_HEADER) : null;
    const heading = ext === ".md" ? line.match(HEADING) : null;
    if (slide) place = { key: `slide${slide[1]}`, where: `Slide ${slide[1]}`, lines: [] };
    else if (heading) place = { key: `s${places.length}`, where: heading[1].trim().slice(0, 60), lines: [] };
    else { place.lines.push(line); continue; }
    places.push(place);
  }
  return places;
}

/** Every figure in a deliverable, or null for a kind this cannot read. */
export async function inventoryFigures(path: string): Promise<Figure[] | null> {
  const ext = extname(path).toLowerCase();
  let text: string;
  try {
    if (ext === ".pptx" || ext === ".docx") text = await extractOfficeText(path, readFileSync(path));
    else if (ext === ".md" || ext === ".csv") text = readFileSync(path, "utf8");
    else return null;
  } catch {
    return null;
  }
  const figures: Figure[] = [];
  for (const place of placesOf(path, text)) {
    const seen = new Set<string>();
    for (const line of place.lines) {
      for (const value of figuresInLine(line)) {
        if (seen.has(value)) continue;
        seen.add(value);
        const context = line.replace(/\s+/g, " ").trim();
        figures.push({ id: `${place.key}#${seen.size}`, where: place.where, value, context: context.length > 160 ? `${context.slice(0, 160)}…` : context });
      }
    }
  }
  return figures;
}

/**
 * How many figures a routine check covers: every one up to seven, then seven
 * plus a quarter of the rest (16 of 40, 31 of 100). The rest are checked when
 * the user asks, or every one from the start when they asked for that.
 */
export function routineSampleSize(total: number): number {
  return total <= 7 ? total : 7 + Math.ceil((total - 7) / 4);
}

/** `count` figures spread across their places, one per place in turn, so every
 *  slide gets a figure checked before any slide gets a second. */
export function spreadPick(figures: Figure[], count: number): Figure[] {
  const byPlace = new Map<string, Figure[]>();
  for (const f of figures) {
    const key = f.id.split("#")[0];
    byPlace.set(key, [...(byPlace.get(key) ?? []), f]);
  }
  const queues = [...byPlace.values()];
  const out: Figure[] = [];
  for (let round = 0; out.length < count && queues.some((q) => q.length > round); round++) {
    for (const q of queues) if (q[round] && out.length < count) out.push(q[round]);
  }
  return out;
}

/** "deck.pptx, Slide 3: $0.42 (in: …)", the line the verifier's brief lists. */
export function figureLine(n: number, path: string, f: Figure): string {
  return `#${n} — ${basename(path)}, ${f.where}: ${f.value} (in: "${f.context}")`;
}
