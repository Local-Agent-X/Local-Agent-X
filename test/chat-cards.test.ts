// @vitest-environment happy-dom
// The cards a reply showed (show_card), in the desktop chat: a strip drawn from the
// turn's tool events (metadata.card), the same live and reloaded. A link is only a
// web address that opens in the browser, and an image only one of the desktop's own
// /images paths, with the auth token the route wants.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, unknown>;
type Card = { title: string; subtitle?: string; image?: string; facts?: Array<{ label: string; value: string }>; links?: Array<{ label: string; url: string }>; source?: string };
type Cards = { cardsOf: (events: unknown[]) => Card[]; renderChatCards: (cards: Card[]) => HTMLElement };

let cards: Cards;

beforeEach(() => {
  g.esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.AUTH_TOKEN = "tok";
  const src = readFileSync(join(here, "../public/js/chat-cards.js"), "utf8");
  // eslint-disable-next-line no-new-func
  cards = new Function(`${src}; return { cardsOf, renderChatCards };`)() as Cards;
});

const glider: Card = {
  title: "Storkcraft Hoop Glider",
  image: "/images/cards/ab12.jpg",
  facts: [{ label: "Price", value: "$189" }],
  links: [{ label: "View on Amazon", url: "https://amazon.com/x" }],
  source: "amazon.com",
};

describe("chat cards", () => {
  it("reads the cards a turn's ended show_card calls carry, in order", () => {
    const events = [
      { type: "start", name: "show_card" },
      { type: "end", name: "show_card", metadata: { card: glider } },
      { type: "end", name: "bash", metadata: {} },
      { type: "end", name: "show_card", metadata: { card: { title: "DaVinci Gabby" } } },
    ];
    expect(cards.cardsOf(events).map((c) => c.title)).toEqual(["Storkcraft Hoop Glider", "DaVinci Gabby"]);
  });

  it("draws the image with the route's token, the facts, and links that open in the browser", () => {
    const strip = cards.renderChatCards([glider]);
    expect(strip.querySelector("img")!.getAttribute("src")).toBe("/images/cards/ab12.jpg?token=tok");
    expect(strip.textContent).toContain("$189");
    const a = strip.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://amazon.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("leaves out a link that is not a web address and an image off the desktop's paths", () => {
    const strip = cards.renderChatCards([{ title: "X", image: "https://elsewhere.example/x.jpg", links: [{ label: "run", url: "javascript:alert(1)" }] }]);
    expect(strip.querySelector("img")).toBeNull();
    expect(strip.querySelector("a")).toBeNull();
  });
});
