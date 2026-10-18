// @vitest-environment happy-dom
//
// Regression (2026-10-17): a generated image with a long prompt showed a second,
// broken "generated image" link under the real one. The chat keeps 500 chars of
// a tool result; the cut landed inside `Saved: …\workspace\images\chatgpt_1792…png`,
// and the media preview read the stub `workspace\images\chatgpt_179` as a path.
// Both cuts (live reducer, reload projection) now drop the unfinished last line,
// so a path is whole or absent.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { uiToolResultText, UI_TOOL_RESULT_MAX_CHARS } from "../src/memory/session-ui-projection.js";

const here = dirname(fileURLToPath(import.meta.url));

const FILE = "chatgpt_1792292957754.png";
const HEAD = "Image generated via ChatGPT (gpt-image-2)!\nPrompt: ";
const SAVED = "\nSaved: C:\\Users\\peter\\Documents\\Local Agent X\\workspace\\images\\";
// The ChatGPT backend's result text (generate-image.ts generateViaCodex), with
// the prompt sized so the 500-char cut lands 11 characters into the file name,
// leaving `chatgpt_179` as in the reported chat.
const PROMPT = "A heroic superhero dog on a rooftop at sunset. ".repeat(20)
  .slice(0, UI_TOOL_RESULT_MAX_CHARS - 11 - HEAD.length - SAVED.length);
const RESULT = `${HEAD}${PROMPT}${SAVED}${FILE}\nView: /images/${FILE}`;

const MEDIA_PATH = /(?:\/(?:images|videos)\/|workspace[\\/](?:images|videos)[\\/])([A-Za-z0-9._-]+)/g;
const namesIn = (text: string) => [...text.matchAll(MEDIA_PATH)].map((m) => m[1]);

describe("a tool result cut for the chat never carries half a media path", () => {
  it("the fixture really puts the cut inside the saved path", () => {
    const naive = RESULT.slice(0, UI_TOOL_RESULT_MAX_CHARS);
    expect(namesIn(naive).some((n) => n !== FILE && FILE.startsWith(n))).toBe(true);
  });

  it("reload: uiToolResultText drops the unfinished last line", () => {
    const cut = uiToolResultText(RESULT);
    expect(cut.length).toBeLessThanOrEqual(UI_TOOL_RESULT_MAX_CHARS);
    expect(namesIn(cut).every((n) => n === FILE)).toBe(true);
    expect(uiToolResultText("short")).toBe("short");
  });

  describe("live: the stream reducer", () => {
    type Store = {
      startTurn(id: string, anchor?: number): unknown;
      applyEvent(id: string, ev: Record<string, unknown>): void;
      get(id: string): { toolEvents: Array<{ type: string; result?: string }> } | undefined;
    };
    let store: Store;
    beforeAll(() => {
      for (const file of ["agentxos-timeline.js", "chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-admit.js", "chat-stream-store.js"]) {
        // eslint-disable-next-line no-new-func
        new Function(readFileSync(join(here, "../public/js", file), "utf8"))();
      }
      store = (globalThis as unknown as { window: { ChatStreamStore: Store } }).window.ChatStreamStore;
    });

    it("keeps the full media URL and no half path", () => {
      store.startTurn("media-cut", 0);
      store.applyEvent("media-cut", { type: "tool_start", toolName: "generate_image", toolCallId: "c1", args: {} });
      store.applyEvent("media-cut", { type: "tool_end", toolName: "generate_image", toolCallId: "c1", allowed: true, status: "ok", result: RESULT });
      const end = store.get("media-cut")!.toolEvents.find((t) => t.type === "end")!;
      const names = namesIn(end.result!);
      expect(names).toContain(FILE);
      expect(names.every((n) => n === FILE)).toBe(true);
    });

    // An event carrying the media name needs no URL rescue: the preview reads
    // the carry, and the text is cut plainly.
    it("keeps the carried media on the end event and cuts the text plainly", () => {
      const media = { kind: "image", name: FILE };
      store.startTurn("media-carry", 0);
      store.applyEvent("media-carry", { type: "tool_start", toolName: "generate_image", toolCallId: "c1", args: {} });
      store.applyEvent("media-carry", { type: "tool_end", toolName: "generate_image", toolCallId: "c1", allowed: true, status: "ok", result: RESULT, media });
      const end = store.get("media-carry")!.toolEvents.find((t) => t.type === "end")! as { result?: string; media?: unknown };
      expect(end.media).toEqual(media);
      expect(end.result!.length).toBeLessThanOrEqual(UI_TOOL_RESULT_MAX_CHARS);
      expect(end.result).not.toContain("View:");
      expect(namesIn(end.result!).every((n) => n === FILE)).toBe(true);
    });
  });
});

// The preview itself: the carried media name is the answer when present; the
// text scan serves only a row persisted before the carry existed.
describe("attachMediaPreview prefers the carried media over the text", () => {
  type Attach = (card: HTMLElement, toolName: string, result: string, media?: { kind: string; name: string }) => void;
  let attach: Attach;
  beforeAll(() => {
    // eslint-disable-next-line no-new-func
    attach = new Function(`${readFileSync(join(here, "../public/js/chat-tool-cards.js"), "utf8")}; return attachMediaPreview;`)() as Attach;
  });

  function cardInBody(): { card: HTMLElement; body: HTMLElement } {
    document.body.innerHTML = "";
    const body = document.createElement("div");
    body.className = "msg-body";
    const card = document.createElement("div");
    body.appendChild(card);
    document.body.appendChild(body);
    return { card, body };
  }
  const srcs = (body: HTMLElement) => [...body.querySelectorAll("img")].map((img) => img.getAttribute("src"));

  it("renders the carried file and ignores every path the text names", () => {
    const { card, body } = cardInBody();
    attach(card, "generate_image", "Saved: C:\\ws\\images\\stale_1.png\nView: /images/stale_2.png", { kind: "image", name: FILE });
    expect(srcs(body)).toEqual([`/images/${FILE}`]);
  });

  it("a video carry renders a player at its route", () => {
    const { card, body } = cardInBody();
    attach(card, "generate_video", "done", { kind: "video", name: "clip.mp4" });
    expect([...body.querySelectorAll("video")].map((v) => v.getAttribute("src"))).toEqual(["/videos/clip.mp4"]);
  });

  it("a row without the carry still scans its text (persisted before the carry)", () => {
    const { card, body } = cardInBody();
    attach(card, "generate_image", RESULT);
    expect(srcs(body)).toEqual([`/images/${FILE}`]);
  });

  it("a tool that produces no preview media renders nothing even with a carry", () => {
    const { card, body } = cardInBody();
    attach(card, "send_image", "sent", { kind: "image", name: FILE });
    expect(srcs(body)).toEqual([]);
  });
});
