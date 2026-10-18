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
  });
});
