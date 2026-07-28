// @vitest-environment happy-dom
//
// Behavioural guard for the composer's ⋯ fold (public/js/chat-composer-overflow.js).
// The sibling composer-bar-contract.test.ts asserts the wiring exists; this one
// drives the actual DOM, because the two bugs this code has to survive are both
// invisible to a string match:
//
//   1. updateStatusBar rebuilds #composer-chips wholesale on every tick. While
//      the Plan chip and project picker are folded, that recreates them in the
//      row alongside the copies already in the popover — same ids, two nodes.
//      Left alone the popover grew one dead twin per tick and getElementById
//      started answering with a stale node.
//   2. Widening has to put them back in #composer-chips in the right order
//      (before the model chip), not merely un-hide them.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../public/js/chat-composer-overflow.js"), "utf8");

// What updateStatusBar writes into #composer-chips on every render.
const CHIPS_HTML =
  '<button id="plan-mode-chip">Plan</button>' +
  '<select id="project-quick-select"></select>' +
  '<button id="model-chip" class="model-chip">grok-4.5</button>';

type Api = {
  sync: () => void;
  foldPlan: (w: number) => string[];
  setWidth: (w: number) => void;
  rebuildChips: () => void;
  ids: (hostId: string) => string[];
  countById: (id: string) => number;
};

function mount(): Api {
  document.body.innerHTML = `
    <div id="chat-main"><div id="input-area"><div id="input-wrapper"><div id="input-box">
      <div id="composer-bar">
        <button id="plus-btn">+</button>
        <span id="composer-chips">${CHIPS_HTML}</span>
        <span style="flex:1"></span>
        <span id="composer-overflow">
          <button id="composer-overflow-btn"></button>
          <span id="composer-overflow-items">
            <button id="dictate-btn" class="input-btn"></button>
            <button id="mic-btn" class="input-btn"></button>
            <button id="voice-cfg-btn" class="input-btn"></button>
          </span>
        </span>
        <button id="stop-btn"></button>
        <button id="send-btn"></button>
      </div>
    </div></div></div></div>`;

  // happy-dom has no layout engine, so the module's one measurement — the chat
  // column's width off #input-area — has to be supplied.
  let width = 1200;
  const area = document.getElementById("input-area")!;
  area.getBoundingClientRect = () => ({ width }) as DOMRect;

  const mod = new Function(`${src}\nreturn { sync: syncComposerOverflow, foldPlan: laxComposerFoldPlan };`)();
  return {
    ...mod,
    setWidth: (w: number) => { width = w; },
    rebuildChips: () => { document.getElementById("composer-chips")!.innerHTML = CHIPS_HTML; },
    ids: (hostId: string) => [...document.getElementById(hostId)!.children].map((c) => c.id),
    countById: (id: string) => document.querySelectorAll(`#${id}`).length,
  };
}

let api: Api;
beforeEach(() => { api = mount(); });

describe("composer fold", () => {
  it("leaves the row alone at full width", () => {
    api.setWidth(1200);
    api.sync();
    expect(api.ids("composer-chips")).toEqual(["plan-mode-chip", "project-quick-select", "model-chip"]);
    expect(api.ids("composer-overflow-items")).toEqual(["dictate-btn", "mic-btn", "voice-cfg-btn"]);
    expect(document.getElementById("composer-overflow")!.classList.contains("has-folded")).toBe(false);
  });

  it("folds the voice trio alone at the middle step", () => {
    // The trio already lives in the popover span — CSS reshapes it, nothing
    // moves — so the chips row must be untouched at this step.
    api.setWidth(420);
    api.sync();
    expect(document.getElementById("composer-overflow")!.classList.contains("has-folded")).toBe(true);
    expect(api.ids("composer-chips")).toEqual(["plan-mode-chip", "project-quick-select", "model-chip"]);
  });

  it("folds Plan and the project picker in at the narrowest step", () => {
    api.setWidth(360);
    api.sync();
    expect(api.ids("composer-chips")).toEqual(["model-chip"]);
    expect(api.ids("composer-overflow-items")).toEqual([
      "dictate-btn", "mic-btn", "voice-cfg-btn", "plan-mode-chip", "project-quick-select",
    ]);
  });

  it("survives repeated chips rebuilds without accumulating dead twins", () => {
    api.setWidth(360);
    api.sync();
    for (let i = 0; i < 6; i++) {
      api.rebuildChips();   // what updateStatusBar does every tick
      api.sync();
    }
    expect(api.ids("composer-overflow-items")).toEqual([
      "dictate-btn", "mic-btn", "voice-cfg-btn", "plan-mode-chip", "project-quick-select",
    ]);
    expect(api.countById("plan-mode-chip")).toBe(1);
    expect(api.countById("project-quick-select")).toBe(1);
    // The surviving node must be the FRESH render, not the stale snapshot —
    // otherwise the Plan chip stops reflecting whether plan mode is on.
    expect(document.getElementById("plan-mode-chip")!.parentElement!.id).toBe("composer-overflow-items");
  });

  it("restores folded controls ahead of the model chip when the column widens", () => {
    api.setWidth(360);
    api.sync();
    api.setWidth(1200);
    api.sync();
    expect(api.ids("composer-chips")).toEqual(["plan-mode-chip", "project-quick-select", "model-chip"]);
    expect(api.ids("composer-overflow-items")).toEqual(["dictate-btn", "mic-btn", "voice-cfg-btn"]);
    expect(document.getElementById("composer-overflow")!.classList.contains("has-folded")).toBe(false);
    expect(api.countById("plan-mode-chip")).toBe(1);
  });

  it("restores cleanly even when a rebuild happened while folded", () => {
    api.setWidth(360);
    api.sync();
    api.rebuildChips();
    api.setWidth(1200);
    api.sync();
    expect(api.ids("composer-chips")).toEqual(["plan-mode-chip", "project-quick-select", "model-chip"]);
    expect(api.countById("plan-mode-chip")).toBe(1);
    expect(api.countById("project-quick-select")).toBe(1);
  });

  it("leaves the row untouched when the pane is unmeasurable", () => {
    // Chat page hidden behind another page: every rect is 0. Folding the row
    // away behind a ⋯ nobody can see would be worse than doing nothing.
    api.setWidth(0);
    api.sync();
    expect(api.ids("composer-chips")).toEqual(["plan-mode-chip", "project-quick-select", "model-chip"]);
    expect(api.foldPlan(0)).toEqual([]);
  });
});
