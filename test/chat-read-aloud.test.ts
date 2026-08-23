// @vitest-environment happy-dom
//
// Behavior contract for the per-bubble "read aloud" button (public/js/
// chat-voice-tts.js speakBubble). The 🔊 on each finalized assistant bubble
// speaks that bubble's rendered text via window.speechSynthesis — ALWAYS (it is
// not gated to the "browser" streaming-TTS engine; the user explicitly asked to
// hear THIS message). It must: chunk long text by sentence (the browser caps
// per-utterance length), strip server history markers, toggle off on a second
// click, hand playback over when another bubble's button is clicked, and no-op
// on empty text.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

class FakeUtterance {
  text: string;
  rate = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}

interface TTSGlobals { speakBubble(btn: Element, body: Element): void }
const g = globalThis as unknown as {
  window: TTSGlobals & Record<string, unknown>;
  document: Document;
  SpeechSynthesisUtterance: typeof FakeUtterance;
};

let utters: FakeUtterance[];   // every utterance handed to speak(), in order
let speaking: boolean;
let cancelCount: number;
let mod: TTSGlobals;

// The stub does NOT auto-advance — it records the utterance and stops. Tests
// drive the chain explicitly via drainQueue() so we can observe intermediate
// state (button "speaking", first chunk only) before completion.
function drainQueue(): void {
  // Fire onend on the last utterance until the module stops queueing new ones.
  let guard = 0;
  while (utters.length && guard++ < 1000) {
    const u = utters[utters.length - 1];
    const before = utters.length;
    u.onend?.();
    if (utters.length === before) break; // no new chunk queued → chain done
  }
}

beforeEach(() => {
  utters = [];
  speaking = false;
  cancelCount = 0;
  document.body.innerHTML = "";

  g.SpeechSynthesisUtterance = FakeUtterance;
  g.window.SpeechSynthesisUtterance = FakeUtterance;
  g.window.speechSynthesis = {
    get speaking() { return speaking; },
    speak(u: FakeUtterance) { utters.push(u); speaking = true; },
    cancel() { cancelCount++; speaking = false; },
    getVoices() { return []; },
    addEventListener() {},
  };
  // Globals stopSpeaking touches (voice-mode); unused by speakBubble but must
  // exist so a stopSpeaking() call in a test doesn't throw.
  g.window.voicePlaybackNode = null;
  (g.window as Record<string, unknown>).isSpeaking = false;
  (g.window as Record<string, unknown>).updateVoiceUI = () => {};

  const src = readFileSync(join(here, "../public/js/chat-voice-tts.js"), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src)();
  mod = g.window as unknown as TTSGlobals;
});

function bubble(text: string): { btn: HTMLButtonElement; body: HTMLElement } {
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  const btn = document.createElement("button");
  btn.className = "read-aloud-btn";
  btn.textContent = "🔊";
  btn.setAttribute("aria-pressed", "false");
  document.body.append(body, btn);
  return { btn, body };
}

describe("speakBubble — playback", () => {
  it("speaks the first sentence and marks the button playing", () => {
    const { btn, body } = bubble("Hello there. How are you?");
    mod.speakBubble(btn, body);
    expect(utters.map(u => u.text)).toEqual(["Hello there."]);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.textContent).toBe("⏹");
  });

  it("chunks a multi-sentence reply and speaks every part in order, then resets", () => {
    const { btn, body } = bubble("One. Two! Three? Four.");
    mod.speakBubble(btn, body);
    drainQueue();
    expect(utters.map(u => u.text)).toEqual(["One.", "Two!", "Three?", "Four."]);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toBe("🔊");
  });

  it("strips server history markers so tool-call dumps are never spoken", () => {
    const { btn, body } = bubble("The answer is 4. [Tool calls this turn: calc(2+2)]");
    mod.speakBubble(btn, body);
    drainQueue();
    expect(utters.map(u => u.text)).toEqual(["The answer is 4."]);
  });

  it("no-ops on empty / whitespace text (no utterance, button stays idle)", () => {
    const { btn, body } = bubble("   \n  ");
    mod.speakBubble(btn, body);
    expect(utters).toHaveLength(0);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("speakBubble — toggling & handover", () => {
  it("a second click on the same button stops playback and resets it", () => {
    const { btn, body } = bubble("Long enough. Another sentence.");
    mod.speakBubble(btn, body);           // start
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    const spokenBefore = utters.length;
    mod.speakBubble(btn, body);           // toggle off
    expect(cancelCount).toBeGreaterThan(0);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toBe("🔊");
    expect(utters.length).toBe(spokenBefore); // nothing new queued
  });

  it("clicking another bubble's button hands playback over and resets the first", () => {
    const a = bubble("First bubble text.");
    const b = bubble("Second bubble text.");
    mod.speakBubble(a.btn, a.body);
    expect(a.btn.getAttribute("aria-pressed")).toBe("true");
    mod.speakBubble(b.btn, b.body);
    expect(cancelCount).toBeGreaterThan(0);
    expect(a.btn.getAttribute("aria-pressed")).toBe("false"); // first reset
    expect(b.btn.getAttribute("aria-pressed")).toBe("true");  // second now playing
    expect(utters[utters.length - 1].text).toBe("Second bubble text.");
  });
});
