import { describe, expect, it, vi } from "vitest";
import { findCardPicture, picturesToTry, type CardPictureSources } from "./card-picture.js";
import type { ImageHit } from "./image-search-tool.js";

const hit = (url: string, page?: string, fallback?: string): ImageHit => ({ url, title: "", width: 0, height: 0, source: "x", ...(page ? { page } : {}), ...(fallback ? { fallback } : {}) });

/** Sources whose save() accepts only the addresses in `fetchable`. */
function sources(opts: { hits?: ImageHit[]; page?: string | null; fetchable: string[] }) {
  const tried: string[] = [];
  const s: CardPictureSources = {
    search: vi.fn(async () => opts.hits ?? []),
    page: vi.fn(async () => opts.page ?? null),
    save: async (source) => {
      tried.push(source);
      if (!opts.fetchable.includes(source)) throw new Error("blocked");
      return `/images/cards/${source.split("/").pop()}`;
    },
  };
  return { s, tried };
}

const CARD = { title: "LMNT Sparkling Watermelon Salt", links: [{ url: "https://www.amazon.com/dp/B0D5ZXVQYR" }] };

describe("findCardPicture", () => {
  it("finds the picture itself and ignores the model's for a card with a link", async () => {
    const { s } = sources({ hits: [hit("https://m.media-amazon.com/a.jpg", "https://amazon.com/dp/B0D5ZXVQYR")], fetchable: ["https://m.media-amazon.com/a.jpg", "https://model.example/m.jpg"] });
    expect(await findCardPicture(CARD, "https://model.example/m.jpg", "s1", s)).toBe("/images/cards/a.jpg");
  });

  it("tries the search engine's copy of a picture before the store's own", async () => {
    const { s, tried } = sources({ hits: [hit("https://store.example/big.jpg", undefined, "https://engine.example/thumb.jpg")], fetchable: ["https://engine.example/thumb.jpg"] });
    expect(await findCardPicture(CARD, undefined, "s1", s)).toBe("/images/cards/thumb.jpg");
    expect(tried).toEqual(["https://engine.example/thumb.jpg"]);
  });

  it("reads the linked page in a hidden tab when the search finds nothing it can fetch", async () => {
    const { s } = sources({ hits: [hit("https://blocked.example/x.jpg")], page: "https://m.media-amazon.com/p.jpg", fetchable: ["https://m.media-amazon.com/p.jpg"] });
    expect(await findCardPicture(CARD, undefined, "s1", s)).toBe("/images/cards/p.jpg");
    expect(s.page).toHaveBeenCalledWith(CARD.links[0].url, "s1");
  });

  it("falls back to the model's picture, then to none", async () => {
    const withModel = sources({ fetchable: ["https://model.example/m.jpg"] });
    expect(await findCardPicture(CARD, "https://model.example/m.jpg", "s1", withModel.s)).toBe("/images/cards/m.jpg");
    const nothing = sources({ fetchable: [] });
    expect(await findCardPicture(CARD, undefined, "s1", nothing.s)).toBeNull();
  });

  it("a search that fails is the same as one that found nothing", async () => {
    const { s } = sources({ page: "https://m.media-amazon.com/p.jpg", fetchable: ["https://m.media-amazon.com/p.jpg"] });
    s.search = vi.fn(async () => { throw new Error("engine down"); });
    expect(await findCardPicture(CARD, undefined, "s1", s)).toBe("/images/cards/p.jpg");
  });

  it("a card with no link uses the model's picture and searches nothing", async () => {
    const { s } = sources({ fetchable: ["https://model.example/m.jpg"] });
    expect(await findCardPicture({ title: "Grandma's recipe" }, "https://model.example/m.jpg", "s1", s)).toBe("/images/cards/m.jpg");
    expect(s.search).not.toHaveBeenCalled();
    expect(s.page).not.toHaveBeenCalled();
  });
});

describe("picturesToTry", () => {
  it("puts pictures from the link's own site first, then the top two from elsewhere", () => {
    const hits = [
      hit("https://a.example/1.jpg", "https://walmart.com/x"),
      hit("https://a.example/2.jpg", "https://www.amazon.com/dp/1"),
      hit("https://a.example/3.jpg", "https://target.com/y"),
      hit("https://a.example/4.jpg", "https://ebay.com/z"),
    ];
    expect(picturesToTry(hits, "https://amazon.com/dp/B0").map((h) => h.url)).toEqual([
      "https://a.example/2.jpg", "https://a.example/1.jpg", "https://a.example/3.jpg",
    ]);
  });
});
