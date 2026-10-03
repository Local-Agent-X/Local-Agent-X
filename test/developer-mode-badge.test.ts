// @vitest-environment happy-dom
//
// Developer mode stays on until the user turns it off, so while it is on the
// chat status bar carries a "Developer mode is on" badge that cannot be
// dismissed, styled like the bar's other warning badge, and a click on it opens
// Settings at the developer-mode toggle. It follows the setting live: the
// initial /api/settings read, then every settings_changed broadcast.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const statusBarJs = readFileSync(join(here, "../public/js/chat-status-bar.js"), "utf8");
const miscJs = readFileSync(join(here, "../public/js/chat-ws-handler-misc.js"), "utf8");
const toolPolicyJs = readFileSync(join(here, "../public/js/settings-tool-policy.js"), "utf8");

type StatusBar = {
  updateStatusBar: (force?: boolean) => void;
  openDeveloperModeSettings: () => void;
  _primeLaxSettings: () => Promise<void>;
};

const openSettings = vi.fn();
let settingsResponse: Record<string, unknown> = {};
const apiFetch = vi.fn(async () => ({ ok: true, json: async () => settingsResponse }));
const esc = (s: unknown) => String(s);

function loadStatusBar(): StatusBar {
  return new Function(
    "esc", "laxResolveActiveProvider", "laxProviderLabel", "openSettings", "apiFetch",
    `${statusBarJs}\nreturn { updateStatusBar, openDeveloperModeSettings, _primeLaxSettings };`,
  )(esc, () => null, (id: string) => id, openSettings, apiFetch);
}

function badge(): HTMLElement | null {
  return document.getElementById("dev-mode-badge");
}

let bar: StatusBar;

beforeEach(() => {
  document.body.innerHTML = `
    <span id="composer-chips"></span>
    <span id="status-bar-dynamic"></span>
    <div id="dev-mode-card" style="display:none"><div id="tp-toggle-developer-mode" class="toggle"></div></div>`;
  delete (window as { _laxDeveloperMode?: boolean })._laxDeveloperMode;
  openSettings.mockClear();
  bar = loadStatusBar();
});

describe("developer-mode badge", () => {
  it("shows while developer_mode is on, from the first settings read", async () => {
    settingsResponse = { developer_mode: true };
    await bar._primeLaxSettings();
    bar.updateStatusBar(true);
    expect(badge()?.textContent).toContain("Developer mode is on");
  });

  it("is absent while developer_mode is off", async () => {
    settingsResponse = { developer_mode: false };
    await bar._primeLaxSettings();
    bar.updateStatusBar(true);
    expect(badge()).toBeNull();
  });

  it("follows settings_changed both ways without a reload", () => {
    const handleSettingsChanged = new Function(
      "updateStatusBar", "loadToolPolicyToggles", `${miscJs}\nreturn handleSettingsChanged;`,
    )(bar.updateStatusBar, () => undefined);

    handleSettingsChanged({ type: "settings_changed", settings: { developer_mode: true } });
    expect(badge()).not.toBeNull();
    handleSettingsChanged({ type: "settings_changed", settings: { developer_mode: false } });
    expect(badge()).toBeNull();
  });

  it("uses the status bar's warning badge look", () => {
    (window as { _laxDeveloperMode?: boolean })._laxDeveloperMode = true;
    bar.updateStatusBar(true);
    const style = badge()?.getAttribute("style") ?? "";
    expect(style).toContain("background:#fef3c7");
    expect(style).toContain("border:1px solid #fbbf24");
    expect(badge()?.classList.contains("status-item")).toBe(true);
  });

  it("opens Settings at the developer-mode toggle", () => {
    (window as { _laxDeveloperMode?: boolean })._laxDeveloperMode = true;
    bar.updateStatusBar(true);
    expect(badge()?.tagName).toBe("BUTTON");
    expect(badge()?.getAttribute("onclick")).toBe("openDeveloperModeSettings()");

    bar.openDeveloperModeSettings();
    expect(openSettings).toHaveBeenCalledWith("security");
  });

  it("the Settings card is reachable whenever developer_mode is on, even off a git checkout", async () => {
    const loaderSrc = toolPolicyJs.replace("document.addEventListener('DOMContentLoaded', loadToolPolicyToggles);", "");
    const loadToolPolicyToggles = new Function(
      "apiFetch", "onProviderChange", "onEmbProviderChange", `${loaderSrc}\nreturn loadToolPolicyToggles;`,
    )(apiFetch, () => undefined, () => undefined);

    settingsResponse = { developer_mode: true, selfEditAvailable: false };
    await loadToolPolicyToggles();
    expect(document.getElementById("dev-mode-card")?.style.display).toBe("");
    expect(document.getElementById("tp-toggle-developer-mode")?.classList.contains("on")).toBe(true);

    settingsResponse = { developer_mode: false, selfEditAvailable: false };
    await loadToolPolicyToggles();
    expect(document.getElementById("dev-mode-card")?.style.display).toBe("none");
  });
});
