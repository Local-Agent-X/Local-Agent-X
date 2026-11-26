// @vitest-environment happy-dom
//
// Two places decide which workspace files a reply names: the desktop chat, which
// links them where they sit in the sentence (public/js/shared-md.js md()), and the
// server, which resolves them once and sends the list to devices with the turn
// (src/workspace/named-files.ts). They read the same text with rules written twice,
// in the browser and on the server; this holds them to the same files, so a phone
// and the desktop never disagree about what a reply gave the user.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { filesNamedInReply } from "../src/workspace/named-files.js";

const here = dirname(fileURLToPath(import.meta.url));
let md: (s: string) => string;

const base = mkdtempSync(join(tmpdir(), "lax-named-files-seam-"));
const workspace = join(base, "workspace");
const FILES = [
  "black-friday-sale/bf-post-1080x1350.png", "black-friday-sale/bf-story-1080x1920.png",
  "promo/teaser.mp4", "promo/jingle.mp3", "promo/all.zip", "decks/q4 plan.pptx", "decks/q4-notes.md", "reports/summary.docx",
];
for (const file of FILES) {
  mkdirSync(join(workspace, file, ".."), { recursive: true });
  writeFileSync(join(workspace, file), "x");
}
afterAll(() => rmSync(base, { recursive: true, force: true }));

beforeAll(() => {
  const escSrc = readFileSync(join(here, "../public/js/shared-escape.js"), "utf8");
  const mdSrc = readFileSync(join(here, "../public/js/shared-md.js"), "utf8");
  // shared-md.js asks the server for the agent origin at load; no answer here.
  // eslint-disable-next-line no-new-func
  md = new Function("fetch", `const AUTH_TOKEN = "";\n${escSrc}\n${mdSrc}\nreturn md;`)(() => new Promise(() => {})) as (s: string) => string;
});

/** The /files addresses md() linked, decoded, in order, each once. */
function linked(reply: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = md(reply);
  const hrefs = [...host.querySelectorAll("a.file-download")].map((a) => decodeURIComponent((a.getAttribute("href") || "").split("?")[0]));
  return [...new Set(hrefs)];
}
const resolved = (reply: string): string[] => filesNamedInReply(reply, { workspace }).map((f) => decodeURIComponent(f.path));

const REPLIES = [
  "There are images in `workspace/black-friday-sale/` on the PC.\n\n- `bf-post-1080x1350.png` : post\n- `bf-story-1080x1920.png` : story",
  "Saved `workspace/promo/teaser.mp4`, `workspace/promo/jingle.mp3` and `workspace/promo/all.zip`.",
  "Story: workspace/black-friday-sale/bf-story-1080x1920.png",
  "Here is [the deck](workspace/decks/q4 plan.pptx), notes in `q4-notes.md`.",
  `Written to \`${join(workspace, "reports", "summary.docx")}\``,
  "Run `npm run build`, then `workspace/promo/make.mjs`.",
];

describe("the desktop chat and the server name the same files", () => {
  it.each(REPLIES)("%s", (reply) => {
    expect(linked(reply)).toEqual(resolved(reply));
  });
});
