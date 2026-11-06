// The voices a call from the phone can speak in, and remembering the one the user
// picks there, so the phone's voice picker (sent as the `voices` event, set back with
// `voice_settings` + `remember`) offers what the desktop's engine can actually say.
//
// The Python sidecar speaks English Kokoro voices and the user's clones (vx:<id>, from
// the VoxCPM sidecar); the in-process engine speaks English Kokoro voices. Each engine
// keeps the user's voice in its own setting (voice-session/settings.ts): ttsVoice for
// the sidecar, voiceTier4Voice in-process, so a pick is saved where that engine reads
// it, and broadcast so the desktop's own picker shows it too.

import { kokoroVoiceList, isValidKokoroVoice } from "./tier4/kokoro-voices.js";
import { resolveVoiceSettings } from "./voice-session/settings.js";
import { setSetting } from "../settings.js";
import { BROADCAST_KEYS } from "../settings-schema.js";
import { createLogger } from "../logger.js";

const logger = createLogger("voice.call-voices");

/** A voice the call can speak in, as the phone's picker lists it. */
export interface CallVoice {
  id: string;
  name: string;
  group: string;
}

const GROUP: Record<string, string> = { "en-US": "American", "en-GB": "British" };
const CLONE_REF = /^(vx|cb):[A-Za-z0-9_-]+$/;

function kokoroVoices(): CallVoice[] {
  return kokoroVoiceList()
    .filter((v) => GROUP[v.language] !== undefined)
    .map((v) => ({ id: v.id, name: v.name.charAt(0).toUpperCase() + v.name.slice(1), group: GROUP[v.language]! }));
}

/** The user's clones on the VoxCPM sidecar; none when it is down. */
export async function voxcpmClones(): Promise<CallVoice[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.LAX_VOXCPM_PORT || "7013"}/clones`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return [];
    const body = (await r.json()) as { clones?: Array<{ id?: unknown; name?: unknown }> };
    return (body.clones ?? []).flatMap((c) =>
      typeof c.id === "string" && CLONE_REF.test(`vx:${c.id}`)
        ? [{ id: `vx:${c.id}`, name: typeof c.name === "string" && c.name ? c.name : c.id, group: "Your voices" }]
        : []);
  } catch {
    return [];
  }
}

/** What the phone's picker offers on this desktop, and the user's voice now ("" when
 *  they never picked one: the engine's default). */
export async function listCallVoices(clones: () => Promise<CallVoice[]> = voxcpmClones): Promise<{ voices: CallVoice[]; current: string }> {
  const s = resolveVoiceSettings();
  if (s.engine === "python") return { voices: [...(await clones()), ...kokoroVoices()], current: s.ttsVoice ?? "" };
  if (s.engine === "tier4" && (s.tier4Provider ?? "kokoro") === "kokoro") return { voices: kokoroVoices(), current: s.tier4Voice ?? "" };
  return { voices: [], current: "" };
}

/** Make `voice` the user's voice for every call on this desktop's engine. A voice that
 *  engine cannot speak is refused (logged), so a stale picker never saves a bad id. */
export async function rememberCallVoice(voice: string): Promise<void> {
  const { engine } = resolveVoiceSettings();
  const field = engine === "python" && (isValidKokoroVoice(voice) || CLONE_REF.test(voice))
    ? "ttsVoice"
    : engine === "tier4" && isValidKokoroVoice(voice) ? "voiceTier4Voice" : null;
  if (field === null) {
    logger.warn(`[call-voices] not saving voice "${voice}": the ${engine} engine cannot speak it`);
    return;
  }
  setSetting(field, voice);
  if (!BROADCAST_KEYS.has(field)) return;
  try {
    const { broadcastAll } = await import("../chat-ws/index.js");
    broadcastAll({ type: "settings_changed", settings: { [field]: voice } });
  } catch { /* no open tabs to tell */ }
}
