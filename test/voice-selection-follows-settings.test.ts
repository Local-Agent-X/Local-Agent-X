// @vitest-environment happy-dom
//
// settings.ttsVoice is the voice every transport speaks with, and the phone,
// the agent's `setting` call and other windows all set it. The desktop page
// kept its own copy (localStorage lax_voice) and never read the server's, so
// a voice set anywhere but this window's picker never showed or played here
// (Peter, 2026-11-04: Optimus Prime saved, picker still on am_adam). The page
// now takes the server's voice on load and on every settings_changed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BROADCAST_KEYS } from "../src/settings-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, "../public/js", f), "utf8");
const statusBarJs = read("chat-status-bar.js");
const modalsJs = read("chat-voice-modals.js");
const miscJs = read("chat-ws-handler-misc.js");

let settingsResponse: Record<string, unknown> = {};
const apiFetch = vi.fn(async () => ({ ok: true, json: async () => settingsResponse }));
const updateStatusBar = vi.fn();
const socket = { readyState: 1, send: vi.fn() };

function primeLaxSettings(): () => Promise<void> {
  return new Function(
    "esc", "laxResolveActiveProvider", "laxProviderLabel", "openSettings", "apiFetch",
    `${statusBarJs}\nreturn _primeLaxSettings;`,
  )(String, () => null, String, () => undefined, apiFetch);
}

function settingsChangedHandler(voiceWS: typeof socket | null): (msg: unknown) => void {
  const adoptSavedVoice = new Function(
    "voiceWS", "WebSocket", "updateStatusBar", `${modalsJs}\nreturn adoptSavedVoice;`,
  )(voiceWS, { OPEN: 1 }, updateStatusBar);
  return new Function(
    "adoptSavedVoice", "updateStatusBar", `${miscJs}\nreturn handleSettingsChanged;`,
  )(adoptSavedVoice, updateStatusBar);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lax_voice", "am_adam");
  updateStatusBar.mockClear();
  socket.send.mockClear();
});

describe("the page's voice follows settings.ttsVoice", () => {
  it("the server announces a voice change to every open window", () => {
    expect(BROADCAST_KEYS.has("ttsVoice")).toBe(true);
  });

  it("takes the saved voice on load", async () => {
    settingsResponse = { ttsVoice: "vx:optimus" };
    await primeLaxSettings()();
    expect(localStorage.getItem("lax_voice")).toBe("vx:optimus");
  });

  it("keeps its own pick when nothing is saved", async () => {
    settingsResponse = { ttsVoice: "" };
    await primeLaxSettings()();
    expect(localStorage.getItem("lax_voice")).toBe("am_adam");
  });

  it("a change made elsewhere moves the picker and the live voice session", () => {
    settingsChangedHandler(socket)({ type: "settings_changed", settings: { ttsVoice: "vx:optimus" } });
    expect(localStorage.getItem("lax_voice")).toBe("vx:optimus");
    expect(updateStatusBar).toHaveBeenCalledWith(true);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: "voice_settings", voice: "vx:optimus", speed: 1.15 });
  });

  it("the echo of this window's own pick changes nothing", () => {
    settingsChangedHandler(socket)({ type: "settings_changed", settings: { ttsVoice: "am_adam" } });
    expect(socket.send).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();
  });

  it("with no voice session open, the next one starts with the new voice", () => {
    settingsChangedHandler(null)({ type: "settings_changed", settings: { ttsVoice: "vx:optimus" } });
    expect(localStorage.getItem("lax_voice")).toBe("vx:optimus");
  });

  it("the server announces a voice-system switch too", () => {
    for (const k of ["voiceMode", "voiceEngine", "voiceTier4Provider", "voiceSttProvider"]) expect(BROADCAST_KEYS.has(k), k).toBe(true);
  });

  it("a voice-system switch made elsewhere replaces this window's stale copy", () => {
    // The window Peter had open on 2026-11-04: cached Edge while the server
    // had moved to Studio, so the picker listed Edge voices and no clones.
    localStorage.setItem("lax_settings", JSON.stringify({ provider: "anthropic", voiceMode: "standard", voiceEngine: "tier4", voiceTier4Provider: "edge-tts", voiceSttProvider: "local-whisper" }));
    settingsChangedHandler(socket)({ type: "settings_changed", settings: { voiceMode: "standard", voiceEngine: "python", voiceTier4Provider: "", voiceSttProvider: "" } });
    expect(JSON.parse(localStorage.getItem("lax_settings") ?? "{}")).toEqual({ provider: "anthropic", voiceMode: "standard", voiceEngine: "python", voiceTier4Provider: "", voiceSttProvider: "" });
    expect(updateStatusBar).toHaveBeenCalledWith(true);
  });

  it("a tier switch's cleared voice does not wipe the picker", () => {
    settingsChangedHandler(socket)({ type: "settings_changed", settings: { ttsVoice: "" } });
    expect(localStorage.getItem("lax_voice")).toBe("am_adam");
  });
});
