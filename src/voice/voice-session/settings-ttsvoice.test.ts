import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression lock for the mobile "not my cloned voice" bug: the voice a user
// picks must become a SERVER-side default (settings.ttsVoice) that
// resolveVoiceSettings exposes — because transports that never send a
// voice_settings message (the mobile app over the broker) can only get the
// right voice from the server. Desktop worked by accident via localStorage.

const state: { settings: Record<string, unknown> } = { settings: {} };

vi.mock("../../settings.js", () => ({
  loadSettings: () => state.settings,
}));

beforeEach(() => { state.settings = {}; });

describe("resolveVoiceSettings ttsVoice", () => {
  it("exposes the persisted voice (clone refs pass through untouched)", async () => {
    state.settings = { voiceEngine: "python", ttsVoice: "vx:optimus" };
    const { resolveVoiceSettings } = await import("./settings.js");
    const r = resolveVoiceSettings();
    expect(r.engine).toBe("python");
    expect(r.ttsVoice).toBe("vx:optimus");
  });

  it("treats empty/whitespace as unset (sidecar default), not an empty voice", async () => {
    state.settings = { voiceEngine: "python", ttsVoice: "   " };
    const { resolveVoiceSettings } = await import("./settings.js");
    expect(resolveVoiceSettings().ttsVoice).toBeUndefined();
  });

  it("survives a settings blob with no voice keys at all", async () => {
    const { resolveVoiceSettings } = await import("./settings.js");
    expect(resolveVoiceSettings().ttsVoice).toBeUndefined();
  });
});
