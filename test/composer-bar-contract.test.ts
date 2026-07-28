// Regression guard for the IN-BOX COMPOSER BAR — the consolidation that moved
// every chat control inside #input-box (public/app.html) and collapsed the
// provider/model/effort <select> row into one model chip that opens a cascading
// menu (public/js/chat-status-bar.js + chat-composer-menus.js).
//
// The wiring here is cross-file and stringly-typed (element ids looked up from
// five different scripts, inline onclick handlers, innerHTML render targets),
// so a careless rename breaks it silently. Assert the contract seams:
//   1. app.html keeps every control id INSIDE #input-box's composer bar;
//   2. the popovers live outside the innerHTML-rebuilt chips span;
//   3. chat-status-bar.js renders into the new targets and exposes the
//      switch/effort helpers the menu file calls;
//   4. chat-composer-menus.js defines the handlers the markup references;
//   5. the voice popover keeps the element ids the voice modals look up.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let html = "";
let statusBarJs = "";
let menusJs = "";
let css = "";
let overflowJs = "";
let foldPlan: (width: number) => string[];

beforeAll(() => {
  html = readFileSync(join(here, "../public/app.html"), "utf8");
  statusBarJs = readFileSync(join(here, "../public/js/chat-status-bar.js"), "utf8");
  menusJs = readFileSync(join(here, "../public/js/chat-composer-menus.js"), "utf8");
  css = readFileSync(join(here, "../public/css/app.css"), "utf8");
  overflowJs = readFileSync(join(here, "../public/js/chat-composer-overflow.js"), "utf8");
  // The module is a classic browser script with no exports; its DOM wiring is
  // behind `typeof document !== 'undefined'`, so evaluating it here is inert
  // and we get the real function rather than a string match on it.
  foldPlan = new Function(`${overflowJs}\nreturn laxComposerFoldPlan;`)();
});

describe("composer bar contract", () => {
  it("keeps every control inside the in-box composer bar", () => {
    const bar = html.match(/<div id="composer-bar">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? "";
    for (const id of ["plus-btn", "composer-chips", "stream-indicator", "dictate-btn", "mic-btn", "voice-cfg-btn", "stop-btn", "send-btn"]) {
      expect.soft(bar, `#${id} must live inside #composer-bar`).toContain(`id="${id}"`);
    }
  });

  it("mounts both popovers outside the innerHTML-rebuilt chips span", () => {
    // #composer-chips is wiped by every updateStatusBar tick; a popover nested
    // inside it would be destroyed mid-interaction.
    const chipsSpan = html.match(/<span id="composer-chips">[\s\S]*?<\/span>/)?.[0] ?? "";
    expect(chipsSpan).not.toContain("model-menu");
    expect(chipsSpan).not.toContain("voice-pop");
    expect(html).toContain('id="model-menu"');
    expect(html).toContain('id="voice-pop"');
  });

  it("chat-status-bar renders chips + info strip and skips rebuilds under an open menu", () => {
    expect(statusBarJs).toContain("getElementById('composer-chips')");
    expect(statusBarJs).toContain("getElementById('status-bar-dynamic')");
    expect(statusBarJs).toMatch(/if \(window\._laxModelMenuOpen\) return/);
    // Voice popover body must only be rebuilt while hidden.
    expect(statusBarJs).toMatch(/voicePop\.style\.display === 'none'/);
  });

  it("exposes the switch path and effort catalogue the cascade menu calls", () => {
    expect(statusBarJs).toMatch(/async function laxSwitchModel\(providerId, model, effort\)/);
    expect(statusBarJs).toMatch(/const LAX_EFFORT_LEVELS =/);
    expect(statusBarJs).toMatch(/function laxGetSavedEffort\(\)/);
    for (const call of ["laxSwitchModel(", "LAX_EFFORT_LEVELS", "laxGetSavedEffort("]) {
      expect.soft(menusJs, `menu file must use ${call}`).toContain(call);
    }
  });

  it("defines every handler the markup references inline", () => {
    for (const fn of ["toggleModelMenu", "toggleVoicePop"]) {
      expect.soft(menusJs, `${fn} must be defined`).toMatch(new RegExp(`function ${fn}\\(`));
    }
    // The speaker button is static markup; the model chip is JS-rendered, so
    // its onclick lives in chat-status-bar.js, not app.html.
    expect(html).toContain('toggleVoicePop(event)');
    expect(statusBarJs).toContain('onclick="toggleModelMenu(event)"');
  });

  it("starts the textarea at one line and caps growth at 10 lines in CSS and JS alike", () => {
    // The composer opens compact (rows=1) and the input listener in
    // chat-uploads.js grows it with content. Both growth caps — CSS
    // max-height and the JS scrollHeight clamp — must stay at 216px
    // (10 lines × 21.6px line-height) or the box jitters at the limit.
    expect(html).toMatch(/<textarea id="msg-input"[^>]*rows="1"/);
    expect(css).toMatch(/#msg-input\{[^}]*max-height:216px/);
    const uploadsJs = readFileSync(join(here, "../public/js/chat-uploads.js"), "utf8");
    expect(uploadsJs).toContain("Math.min(this.scrollHeight, 216)");
  });

  it("keeps the voice-picker element ids the voice modals look up", () => {
    // chat-voice-modals.js / chat-voice-modal-chatterbox.js re-select these by id.
    for (const id of ["voice-quick-select", "voice-speed-slider", "voice-speed-label"]) {
      expect.soft(statusBarJs, `voice popover must render #${id}`).toContain(`id="${id}"`);
    }
  });
});

// The chat pane loses width to the right rail (browser / agents drag) as often
// as to a small window. A @media query only sees the window, so keying the
// composer's shrink steps to one left the chips clipped mid-word whenever the
// rail was dragged wide on a big monitor. These guard the container-scoped
// replacement — the seam is CSS in one file and thresholds in another.
describe("composer responsiveness is chat-column scoped", () => {
  it("declares #chat-main as the `chat` query container", () => {
    expect(css).toMatch(/#chat-main\{[^}]*container-type:inline-size/);
    expect(css).toMatch(/#chat-main\{[^}]*container-name:chat/);
  });

  it("keys every composer/message shrink step to @container, never @media", () => {
    const steps = [...css.matchAll(/@container chat \(max-width:\s*(\d+)px\)/g)].map(m => Number(m[1]));
    expect(steps).toEqual([720, 560, 460, 380]);

    // The window-scoped mobile block must not re-declare any of them: two
    // sources of truth for the same rule is how this drifts back apart.
    const mobile = css.match(/@media \(max-width:768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(mobile.length).toBeGreaterThan(0);
    for (const sel of ["#composer-chips", ".model-chip", "#messages{", "#input-box{", ".msg{"]) {
      expect.soft(mobile, `${sel} must be container-scoped, not @media-scoped`).not.toContain(sel);
    }
  });

  it("gives the model chip the class hooks its shrink steps target", () => {
    // Step 1 hides the provider, step 2 the thinking depth. Both need a class
    // to grab — the chip used to render bare <span>s.
    for (const cls of ["mc-provider", "mc-provider-sep", "mc-effort", "mc-effort-sep", "mc-model"]) {
      expect.soft(statusBarJs, `model chip must render .${cls}`).toContain(cls);
    }
    for (const cls of ["mc-provider", "mc-effort"]) {
      expect.soft(css, `.${cls} must be hidden by a container step`).toContain(`.model-chip .${cls}`);
    }
    expect(html).toContain('class="si-label"');
  });

  it("stops the composer and message column from setting their own width floor", () => {
    // A flex item's default min-width:auto is its min-content width, so one
    // long unbroken token — or just the non-shrinkable button cluster — used to
    // push the composer wider than the pane and slide send off the right edge.
    expect(css).toMatch(/#input-box\{[^}]*min-width:0/);
    expect(css).toMatch(/#composer-bar\{[^}]*min-width:0/);
    expect(css).toMatch(/#msg-input\{[^}]*min-width:0/);
    expect(css).toMatch(/#msg-input\{[^}]*width:100%/);
    expect(css).toMatch(/#msg-input\{[^}]*overflow-wrap:anywhere/);
    // #messages is a CENTERED column, so a scrollbar appearing as the composer
    // auto-grows re-centred every message sideways. Reserve the gutter.
    expect(css).toMatch(/#messages\{[^}]*scrollbar-gutter:stable both-edges/);
  });
});

describe("composer overflow folding", () => {
  it("folds nothing at full width and everything at the narrowest", () => {
    expect(foldPlan(900)).toEqual([]);
    expect(foldPlan(461)).toEqual([]);
    expect(foldPlan(460)).toEqual(["dictate-btn", "mic-btn", "voice-cfg-btn"]);
    expect(foldPlan(381)).toEqual(["dictate-btn", "mic-btn", "voice-cfg-btn"]);
    expect(foldPlan(380)).toEqual([
      "dictate-btn", "mic-btn", "voice-cfg-btn", "plan-mode-chip", "project-quick-select",
    ]);
  });

  it("folds nothing when the pane is unmeasurable", () => {
    // The chat page is display:none behind other pages — every rect is 0. Folding
    // the row away behind a ⋯ nobody can see would be worse than leaving it.
    for (const w of [0, -1, NaN, undefined as unknown as number]) {
      expect.soft(foldPlan(w), `width ${w} must fold nothing`).toEqual([]);
    }
  });

  it("mirrors the CSS breakpoints in its JS thresholds", () => {
    // The fold steps and the shrink steps are two halves of one behaviour; if
    // they drift the chips shrink at one width and vanish at another.
    expect(overflowJs).toMatch(/COMPOSER_FOLD_VOICE = 460/);
    expect(overflowJs).toMatch(/COMPOSER_FOLD_CHIPS = 380/);
    expect(css).toContain("@container chat (max-width: 460px)");
    expect(css).toContain("@container chat (max-width: 380px)");
  });

  it("moves controls instead of duplicating them", () => {
    // #dictate-btn / #mic-btn carry live state classes and are re-selected by id
    // from chat-dictate.js and chat-voice-mic.js — a second copy would desync.
    for (const id of ["dictate-btn", "mic-btn", "voice-cfg-btn"]) {
      const hits = html.split(`id="${id}"`).length - 1;
      expect.soft(hits, `#${id} must appear exactly once in the markup`).toBe(1);
    }
    expect(overflowJs).toContain("appendChild");
    expect(overflowJs).not.toContain("cloneNode");
    // The voice trio's home IS the popover span, so folding it is pure CSS;
    // only the chips-owned controls are real moves.
    const moves = overflowJs.match(/COMPOSER_FOLD_MOVES = \[([\s\S]*?)\];/)?.[1] ?? "";
    expect(moves).toContain("plan-mode-chip");
    expect(moves).toContain("project-quick-select");
    expect(moves).not.toContain("dictate-btn");
  });

  it("re-folds after every chips rebuild and dismisses against the other popovers", () => {
    // updateStatusBar rewrites #composer-chips wholesale, resurrecting the Plan
    // chip and project picker in the row.
    expect(statusBarJs).toContain("syncComposerOverflow()");
    expect(menusJs).toContain("_closeComposerOverflowIfPresent()");
    expect(html).toContain('onclick="toggleComposerOverflow(event)"');
    expect(overflowJs).toMatch(/function toggleComposerOverflow\(/);
    // Width comes from the chat column, not the window.
    expect(overflowJs).toContain("getElementById('input-area')");
    expect(overflowJs).toContain("ResizeObserver");
  });
});
