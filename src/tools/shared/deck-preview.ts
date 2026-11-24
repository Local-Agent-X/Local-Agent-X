/**
 * The agent looks at a deck before it hands it over. A deck tool returns the
 * rendered slides (contact sheets, inline through the result's `_images`
 * envelope) and the problems the checks found, with the instruction to fix
 * them first.
 *
 * Before this, the only preview needed LibreOffice; without it the agent
 * delivered decks it had never seen, like a pitch deck of twelve white
 * slides (2026-11-23).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import type { OfficeTheme } from "./office-theme.js";
import type { SlidePlan } from "./slide-plan.js";
import { contactSheets } from "./slide-raster.js";
import { checkDeck } from "./slide-checks.js";

export interface PreviewImage { path: string; question: string; mime: string; b64: string }

export interface DeckPreview {
  /** Appended to the tool's result text. */
  text: string;
  /** For the result's `_images` envelope: the model sees them with the text. */
  images: PreviewImage[];
  findings: string[];
}

/** Render, check, and word the look-before-delivering step. A render failure
 *  never fails the deck: the file is written; the text says what is missing. */
export async function previewDeck(plans: SlidePlan[], t: OfficeTheme): Promise<DeckPreview> {
  const findings = checkDeck(plans);
  const lines: string[] = [];
  lines.push(findings.length
    ? `Slide check found ${findings.length} problem(s):\n${findings.map((f) => `- ${f}`).join("\n")}`
    : "Slide check: no overflow, contrast, density or repetition problems found.");
  let images: PreviewImage[] = [];
  try {
    const sheets = await contactSheets(plans, t);
    const dir = join(getLaxDir(), "uploads");
    mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    images = sheets.map((buf, i) => {
      const path = join(dir, `deck-preview-${stamp}-${i + 1}.jpg`);
      writeFileSync(path, buf);
      const from = i * 9 + 1, to = Math.min(plans.length, from + 8);
      return {
        path, mime: "image/jpeg", b64: buf.toString("base64"),
        question: `The deck you just made, rendered (slides ${from}-${to}, numbered). Look at it as the audience will.`,
      };
    });
    lines.push(
      "The rendered slides are shown to you. Look at them before you reply: is the cover strong, is any slide crowded, " +
      "repetitive or off-message, does each layout fit what the slide says? Fix what is wrong (create the deck again " +
      "with corrected specs) before telling the user it is done, and do not describe slides you have not seen.",
    );
  } catch (e) {
    lines.push(`Slides could not be rendered for review (${(e as Error).message}); the deck itself was written.`);
  }
  return { text: lines.join("\n"), images, findings };
}
