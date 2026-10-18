/**
 * The user's default image engine (Settings → Media): the engine an image
 * call uses when the chat model has no image backend of its own. Read by
 * resolveMediaProvider (shared.ts); kept apart from it so the boot-time
 * migration loads nothing but the settings file.
 */
import { loadSettings, saveSettings } from "../../settings.js";
import { IMAGE_ENGINES } from "../../settings-schema.controls.js";

export type ImageEngine = (typeof IMAGE_ENGINES)[number];

const isImageEngine = (v: unknown): v is ImageEngine => (IMAGE_ENGINES as readonly unknown[]).includes(v);

/** The saved default image engine; Grok when none is saved. */
export function imageEngineSetting(): ImageEngine {
  const v = loadSettings().imageEngine;
  return isImageEngine(v) ? v : "grok";
}

/**
 * One-time move off `preferGrokForMedia`, the boolean that held this choice
 * before it was a two-engine pick: true or absent was Grok, and false was the
 * user turning Grok off, so it becomes ChatGPT. The old key is removed, and a
 * stored `imageEngine` that is not an engine is dropped. Returns true when it
 * rewrote settings.json.
 */
export function migrateImageEngineSetting(): boolean {
  const { preferGrokForMedia, ...rest } = loadSettings();
  const hadOldKey = preferGrokForMedia !== undefined;
  const invalidEngine = rest.imageEngine !== undefined && !isImageEngine(rest.imageEngine);
  if (!hadOldKey && !invalidEngine) return false;
  if (invalidEngine) delete rest.imageEngine;
  if (hadOldKey && rest.imageEngine === undefined) rest.imageEngine = preferGrokForMedia === false ? "chatgpt" : "grok";
  saveSettings(rest);
  return true;
}
