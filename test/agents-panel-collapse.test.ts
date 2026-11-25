// @vitest-environment happy-dom
//
// Closing the right panel must leave nothing of it on screen, whether or not
// the close animation ever finishes. Two leaks reached the user (2026-11-24):
// text from the panel (the browser tab's error card) showing as a sliver down
// the chat's right edge after close, and the native browser view staying
// painted over a closed panel. Both came from the closed state being applied
// only in the spring's onDone: the open path's inline overflow:visible was
// never cleared, and onDone runs on requestAnimationFrame, which can stall.
//
// The real toggleAgentFeeds runs here against a Spring stub whose animations
// never finish unless the test says so.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Anim = { onDone?: () => void };
let pending: Anim[];
let toggle: () => void;
let panel: HTMLElement;

function finishAnimations(): void {
  const done = pending;
  pending = [];
  for (const a of done) a.onDone?.();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="agent-feeds" class="agent-feeds collapsed"></div>';
  document.body.className = "";
  panel = document.getElementById("agent-feeds")!;
  pending = [];
  const Spring = {
    animate: (el: HTMLElement, prop: string, target: number, opts: Anim) => {
      el.style.setProperty(prop, target + "px");
      pending.push(opts);
    },
  };
  const src = readFileSync(join(here, "../public/js/chat-agent-feeds.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "Spring",
    "var agentFeedsOpen = false; var AGENT_FEEDS_MOBILE = 300;" +
      " function agentFeedsIsMobile() { return false; }" +
      " function getAgentFeedsWidth() { return 640; }\n" +
      src +
      "\nreturn toggleAgentFeeds;",
  );
  toggle = factory(Spring);
});

describe("closing the right panel", () => {
  it("is closed and clipped the moment it is toggled, before any frame runs", () => {
    toggle();
    finishAnimations(); // fully open: the open path leaves overflow:visible inline
    expect(panel.style.overflow).toBe("visible");

    toggle(); // close; the spring never gets a frame
    expect(panel.classList.contains("collapsed")).toBe(true);
    expect(panel.classList.contains("active")).toBe(false);
    expect(panel.style.overflow).toBe("hidden");
  });

  it("leaves no inline overflow behind once the close animation lands", () => {
    toggle();
    finishAnimations();
    toggle();
    finishAnimations();
    expect(panel.classList.contains("collapsed")).toBe(true);
    expect(panel.style.overflow).toBe("");
    expect(panel.style.width).toBe("");
    expect(panel.style.minWidth).toBe("");
  });

  it("reopening mid-close drops the collapsed state at once", () => {
    toggle();
    finishAnimations();
    toggle(); // closing, not finished
    toggle(); // reopen
    expect(panel.classList.contains("collapsed")).toBe(false);
    expect(panel.classList.contains("active")).toBe(true);
  });
});
