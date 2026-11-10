// show_card shows the user a card: the arguments are trimmed to what the clients draw,
// and its one off-box fetch, the image, is saved under the workspace's images/cards
// and served from there, only when it is a raster picture of at most 5 MB. A card
// whose image cannot be had is still shown, without it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workspace = "";
vi.mock("../config.js", () => ({ getRuntimeConfig: () => ({ workspace }) }));
vi.mock("./image-search-tool.js", () => ({ searchWebImages: vi.fn(async () => []) }));
vi.mock("../browser/page-picture.js", () => ({ pagePicture: vi.fn(async () => null) }));
const { cardImage, cardOf, showCardTool } = await import("./show-card.js");
const { searchWebImages } = await import("./image-search-tool.js");

beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "lax-show-card-")); });
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function fakeFetch(type: string, bytes = 10, status = 200) {
  return vi.fn(async () => new Response(new Uint8Array(bytes), { status, headers: { "content-type": type } })) as never;
}

describe("cardOf", () => {
  it("keeps what the clients draw: at most 4 facts, 3 links, web links only", () => {
    const card = cardOf({
      title: "  Glider  ",
      facts: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, value: `V${n}` })),
      links: [{ label: "Buy", url: "https://a.com" }, { label: "Bad", url: "javascript:x" }, { label: "B", url: "https://b.com" }, { label: "C", url: "https://c.com" }, { label: "D", url: "https://d.com" }],
    });
    expect(card?.title).toBe("Glider");
    expect(card?.facts).toHaveLength(4);
    expect(card?.links?.map((l) => l.label)).toEqual(["Buy", "B", "C"]);
    expect(cardOf({ subtitle: "no title" })).toBeNull();
  });
});

describe("cardImage", () => {
  it("fetches a web picture once, into images/cards, and serves it from there", async () => {
    const fetch = fakeFetch("image/jpeg");
    const path = await cardImage("https://m.media-amazon.com/glider.jpg", fetch);
    expect(path).toMatch(/^\/images\/cards\/[0-9a-f]{24}\.jpg$/);
    expect(existsSync(join(workspace, "images", path.slice("/images/".length)))).toBe(true);
    expect(await cardImage("https://m.media-amazon.com/glider.jpg", fetch)).toBe(path);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses what is not a raster picture, or is over 5 MB", async () => {
    await expect(cardImage("https://x.com/a.svg", fakeFetch("image/svg+xml"))).rejects.toThrow(/not a picture/);
    await expect(cardImage("https://x.com/a.html", fakeFetch("text/html"))).rejects.toThrow(/not a picture/);
    await expect(cardImage("https://x.com/big.png", fakeFetch("image/png", 5 * 1024 * 1024 + 1))).rejects.toThrow(/over 5 MB/);
    await expect(cardImage("file:///etc/passwd", fakeFetch("image/png"))).rejects.toThrow(/not a web address/);
  });

  it("passes an existing /images path through, and refuses one outside the images folder", async () => {
    mkdirSync(join(workspace, "images"), { recursive: true });
    writeFileSync(join(workspace, "images", "made.png"), "png");
    expect(await cardImage("/images/made.png")).toBe("/images/made.png");
    await expect(cardImage("/images/../secret.txt")).rejects.toThrow(/no such image/);
  });
});

describe("show_card finds its own picture", () => {
  const saved = (name: string) => {
    mkdirSync(join(workspace, "images"), { recursive: true });
    writeFileSync(join(workspace, "images", name), "png");
    return `/images/${name}`;
  };

  it("a card with a link gets the picture the tool found, not the one the model passed", async () => {
    const found = saved("found.png");
    const model = saved("model.png");
    vi.mocked(searchWebImages).mockResolvedValueOnce([{ url: "https://store.example/p.jpg", fallback: found, title: "", width: 0, height: 0, source: "x" }]);
    const r = await showCardTool.execute({ title: "LMNT Sparkling", image: model, links: [{ label: "Amazon", url: "https://www.amazon.com/dp/B0" }] });
    expect((r.metadata as { card: { image?: string } }).card.image).toBe(found);
  });

  it("a card nothing could be found for is still shown, without a picture", async () => {
    const r = await showCardTool.execute({ title: "LMNT Sparkling", links: [{ label: "Amazon", url: "https://www.amazon.com/dp/B0" }] });
    expect((r.metadata as { card: { image?: string } }).card.image).toBeUndefined();
    expect(r.content).toContain("without a picture");
    expect(r.isError).toBeUndefined();
  });
});
