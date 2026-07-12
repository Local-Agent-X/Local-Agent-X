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

beforeAll(() => {
  html = readFileSync(join(here, "../public/app.html"), "utf8");
  statusBarJs = readFileSync(join(here, "../public/js/chat-status-bar.js"), "utf8");
  menusJs = readFileSync(join(here, "../public/js/chat-composer-menus.js"), "utf8");
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

  it("keeps the voice-picker element ids the voice modals look up", () => {
    // chat-voice-modals.js / chat-voice-modal-chatterbox.js re-select these by id.
    for (const id of ["voice-quick-select", "voice-speed-slider", "voice-speed-label"]) {
      expect.soft(statusBarJs, `voice popover must render #${id}`).toContain(`id="${id}"`);
    }
  });
});
