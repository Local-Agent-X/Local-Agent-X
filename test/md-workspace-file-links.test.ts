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
import { describe, it, expect, beforeAll } from "vitest";
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

  it("leaves code, programs and paths outside the workspace as code", () => {
    for (const text of ["`workspace/black-friday-sale/make.mjs`", "`workspace/tools/setup.exe`", "`C:\\Users\\peter\\Pictures\\photo.png`", "`npm run build`"]) {
      const html = md(text);
      expect(fileLinks(html)).toEqual([]);
      expect(html).toContain('class="inline-code"');
    }
  });
});
