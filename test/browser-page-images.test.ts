// @vitest-environment happy-dom
// The browser's `images` action reads a page's pictures for show_card: the preview
// image first, then visible pictures at least 80 px on a side with their alt text and
// the link they sit in, web addresses only, no repeats. It reads and returns; it never
// changes the page, and the evaluate blocklist clears it.
import { describe, it, expect } from "vitest";
import { PAGE_IMAGES_SCRIPT } from "../src/browser/page-images.js";
import { scanEvaluateScript } from "../src/browser/guards.js";

function sized(el: HTMLImageElement, w: number, h: number): void {
  el.getBoundingClientRect = () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

describe("PAGE_IMAGES_SCRIPT", () => {
  it("passes the evaluate blocklist", () => {
    expect(scanEvaluateScript(PAGE_IMAGES_SCRIPT)).toBeNull();
  });

  it("lists the preview image, then big pictures with their alt and link, once each", () => {
    document.head.innerHTML = '<meta property="og:image" content="https://cdn.example/preview.jpg">';
    document.body.innerHTML =
      '<a href="https://shop.example/glider"><img id="a" src="https://cdn.example/glider.jpg" alt="Hoop Glider"></a>' +
      '<img id="b" src="https://cdn.example/icon.png" alt="icon">' +
      '<img id="c" src="https://cdn.example/glider.jpg" alt="again">' +
      '<img id="d" src="data:image/png;base64,AAAA" alt="inline">';
    sized(document.getElementById("a") as HTMLImageElement, 200, 200);
    sized(document.getElementById("b") as HTMLImageElement, 16, 16);
    sized(document.getElementById("c") as HTMLImageElement, 200, 200);
    sized(document.getElementById("d") as HTMLImageElement, 200, 200);
    const before = document.body.innerHTML;
    // eslint-disable-next-line no-eval
    const list = JSON.parse((0, eval)(PAGE_IMAGES_SCRIPT) as string) as Array<{ src: string; alt: string; link?: string }>;
    expect(list.map((i) => i.src)).toEqual(["https://cdn.example/preview.jpg", "https://cdn.example/glider.jpg"]);
    expect(list[1]).toEqual({ src: "https://cdn.example/glider.jpg", alt: "Hoop Glider", link: "https://shop.example/glider" });
    expect(document.body.innerHTML).toBe(before);
  });
});
