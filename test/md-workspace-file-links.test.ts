// @vitest-environment happy-dom
//
// A file the agent made and named in its reply is something to click.
//
// Live 2026-11-26: the agent made two Black Friday graphics and named them as
// `workspace/black-friday-sale/bf-post-1080x1350.png`. md() linked only
// document types, so both rendered as plain code with nothing to open; a path
// written in full (C:\Users\…\workspace\…) was never linked at all. The link
// is the .file-download anchor that openFileLink (shared-dom.js) opens in the
// in-app browser.
import { afterEach, describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let md: (s: string) => string;

beforeAll(() => {
  const escSrc = readFileSync(join(here, "../public/js/shared-escape.js"), "utf8");
  const mdSrc = readFileSync(join(here, "../public/js/shared-md.js"), "utf8");
  // shared-md.js asks the server for the agent origin at load; no answer here.
  // eslint-disable-next-line no-new-func
  md = new Function("fetch", `const AUTH_TOKEN = "";\n${escSrc}\n${mdSrc}\nreturn md;`)(() => new Promise(() => {})) as (s: string) => string;
});

/** The hrefs of the file links md() drew. */
function fileLinks(html: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  return [...host.querySelectorAll("a.file-download")].map((a) => a.getAttribute("href") || "");
}

describe("md() links the workspace files a reply names", () => {
  it("links an image named in backticks", () => {
    const html = md("**Feed post (1080×1350):** `workspace/black-friday-sale/bf-post-1080x1350.png`");
    expect(fileLinks(html)).toEqual(["/files/black-friday-sale/bf-post-1080x1350.png"]);
    expect(html).toContain("bf-post-1080x1350.png");
    expect(html).not.toContain('class="inline-code"');
  });

  it("links a bare image path and a page", () => {
    expect(fileLinks(md("Story: workspace/black-friday-sale/bf-story-1080x1920.png"))).toEqual(["/files/black-friday-sale/bf-story-1080x1920.png"]);
    expect(fileLinks(md("Open workspace/menu/index.html to see it"))).toEqual(["/files/menu/index.html"]);
  });

  it("links a full Windows or POSIX path into the workspace as its workspace path", () => {
    expect(fileLinks(md("`C:\\Users\\peter\\Documents\\Local Agent X\\workspace\\black-friday-sale\\bf-post.png`"))).toEqual(["/files/black-friday-sale/bf-post.png"]);
    expect(fileLinks(md("`/c/Users/peter/Documents/Local Agent X/workspace/reports/q4.pdf`"))).toEqual(["/files/reports/q4.pdf"]);
  });

  it("still links the documents it linked before", () => {
    expect(fileLinks(md("Saved to `workspace/reports/summary.docx`"))).toEqual(["/files/reports/summary.docx"]);
  });

  it("links a video, a song and a zip the agent made", () => {
    expect(fileLinks(md("`workspace/promo/teaser.mp4`, `workspace/promo/jingle.mp3` and `workspace/promo/all.zip`"))).toEqual([
      "/files/promo/teaser.mp4", "/files/promo/jingle.mp3", "/files/promo/all.zip",
    ]);
  });

  it("leaves code and programs as code", () => {
    for (const text of ["`workspace/black-friday-sale/make.mjs`", "`workspace/tools/setup.exe`", "`npm run build`"]) {
      const html = md(text);
      expect(fileLinks(html)).toEqual([]);
      expect(html).toContain('class="inline-code"');
    }
  });
});

// Live 2026-11-26: a reply said the images were in `workspace/black-friday-sale/`
// on the PC, then listed six by name alone. None was a link.
describe("md() links a file named alone in the folder the reply named", () => {
  it("links each name in a list under the folder line", () => {
    const reply = [
      "There are 6 images in `workspace/black-friday-sale/` on the PC.",
      "",
      "- `bf-post-1080x1350.png` : main post",
      "- `bf-story-1080x1920.png` : story version",
    ].join("\n");
    expect(fileLinks(md(reply))).toEqual([
      "/files/black-friday-sale/bf-post-1080x1350.png",
      "/files/black-friday-sale/bf-story-1080x1920.png",
    ]);
  });

  it("takes the folder from a full path, a file's own path, or a link already drawn", () => {
    expect(fileLinks(md("Saved in `C:\\Users\\peter\\Documents\\Local Agent X\\workspace\\promo\\`: `a.png`"))).toEqual(["/files/promo/a.png"]);
    expect(fileLinks(md("`workspace/promo/a.png` and `b.png`"))).toEqual(["/files/promo/a.png", "/files/promo/b.png"]);
    expect(fileLinks(md("[the deck](workspace/decks/q4.pptx), notes in `q4-notes.md`"))).toEqual(["/files/decks/q4.pptx", "/files/decks/q4-notes.md"]);
  });

  it("uses the folder named last before the name", () => {
    expect(fileLinks(md("In `workspace/one/`: `a.png`. In `workspace/two/`: `b.png`"))).toEqual(["/files/one/a.png", "/files/two/b.png"]);
  });

  it("leaves a name as code with no folder before it, or when it is a script", () => {
    expect(fileLinks(md("`a.png` is in `workspace/promo/`"))).toEqual([]);
    expect(fileLinks(md("`workspace/promo/` holds `make.mjs`"))).toEqual([]);
  });
});

// A file outside the workspace (a photo in Pictures) opens in its own program
// through the desktop app, which decides what it may reach. Outside the desktop
// app nothing can open it, so it stays code.
describe("md() links files outside the workspace in the desktop app", () => {
  const w = window as unknown as { desktop?: unknown };
  afterEach(() => { delete w.desktop; });

  /** The data-local-path of each local-file link md() drew. */
  function localPaths(html: string): string[] {
    const host = document.createElement("div");
    host.innerHTML = html;
    return [...host.querySelectorAll("a.file-download[data-local-path]")].map((a) => a.getAttribute("data-local-path") || "");
  }

  it("links a full path in backticks or a markdown link, as the desktop takes it", () => {
    w.desktop = { openFile: () => "" };
    expect(localPaths(md("`C:\\Users\\peter\\Pictures\\photo.png`"))).toEqual(["C:/Users/peter/Pictures/photo.png"]);
    expect(localPaths(md("`/c/Users/peter/Downloads/menu.pdf`"))).toEqual(["C:/Users/peter/Downloads/menu.pdf"]);
    expect(localPaths(md("[the flyer](C:\\Users\\peter\\Desktop\\flyer.pdf)"))).toEqual(["C:/Users/peter/Desktop/flyer.pdf"]);
    expect(md("[the flyer](C:\\Users\\peter\\Desktop\\flyer.pdf)")).toContain(">the flyer</a>");
  });

  it("never links a program or an address of this app", () => {
    w.desktop = { openFile: () => "" };
    expect(localPaths(md("`C:\\Users\\peter\\Downloads\\setup.exe`"))).toEqual([]);
    expect(localPaths(md("`/files/report.pdf`"))).toEqual([]);
  });

  it("stays code outside the desktop app", () => {
    const html = md("`C:\\Users\\peter\\Pictures\\photo.png`");
    expect(localPaths(html)).toEqual([]);
    expect(html).toContain('class="inline-code"');
  });
});
