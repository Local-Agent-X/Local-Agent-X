/**
 * A skin's own files: its background (a picture or a short video) and the
 * code of a custom moving layer. They are copied into the skin's folder
 * (skin-store.ts), never pointed at where they came from, so a cleared
 * uploads folder never breaks a skin and sync carries them along.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { writeValidatedFile } from "../security/layer/index.js";
import { moveToTrash } from "../safe-delete.js";
import { tombstoneLibraryItemEagerly } from "../sync/tombstones.js";
import { findSkin, skinDir, writeSkin, type Skin } from "./skin-store.js";

/** What the window can paint behind itself. No SVG: it is a document. */
export const SKIN_BACKGROUND_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"] as const;
/** Sync carries files up to 10 MB (sync/constants.ts MAX_FILE_SIZE). */
export const MAX_SKIN_FILE_BYTES = 10_000_000;
export const MAX_SKIN_CODE_CHARS = 60_000;
/** The one name a skin's effect code is stored under. */
export const SKIN_CODE_FILE = "effect.js";

function known(ref: string): Skin {
  const skin = findSkin(ref);
  if (!skin) throw new Error(`No saved theme "${ref}".`);
  return skin;
}

const stamped = (skin: Skin, change: Partial<Skin>): Skin => {
  const saved = { ...skin, ...change, updatedAt: new Date().toISOString() };
  writeSkin(saved);
  return saved;
};

/** Copy a picture or video in as the skin's background, replacing the last one. */
export async function setSkinBackground(ref: string, file: { name: string; data: Buffer }): Promise<Skin> {
  const skin = known(ref);
  const ext = extname(file.name).toLowerCase();
  if (!(SKIN_BACKGROUND_EXT as readonly string[]).includes(ext)) {
    throw new Error(`A background can be ${SKIN_BACKGROUND_EXT.join(", ")}; not ${ext || "a file without an extension"}.`);
  }
  if (file.data.length > MAX_SKIN_FILE_BYTES) {
    throw new Error(`That file is ${Math.round(file.data.length / 1e6)} MB; a background can be up to 10 MB so it syncs. A shorter or smaller video works.`);
  }
  const dir = skinDir(skin.slug);
  mkdirSync(dir, { recursive: true });
  const name = `background${ext}`;
  // A background of another type would be left behind under its own name.
  for (const f of readdirSync(dir)) if (f.startsWith("background.") && f !== name) await moveToTrash(join(dir, f), `skin_file:${skin.slug}`);
  writeValidatedFile(join(dir, name), file.data);
  return stamped(skin, { background: name });
}

/** Take the background out, to the trash. */
export async function clearSkinBackground(ref: string): Promise<Skin> {
  const skin = known(ref);
  if (!skin.background) return skin;
  const path = join(skinDir(skin.slug), skin.background);
  if (existsSync(path)) await moveToTrash(path, `skin_file:${skin.slug}`);
  return stamped(skin, { background: undefined });
}

/**
 * Save the code of the skin's own moving layer and turn it on. The code never
 * runs in the app's window: public/js/skin-effect-frame.js runs it in a
 * sandboxed frame with no origin and no network, so what is written here can
 * draw and nothing else.
 */
export function setSkinEffectCode(ref: string, code: string): Skin {
  const skin = known(ref);
  if (!code.trim()) throw new Error("The effect code is empty.");
  if (code.length > MAX_SKIN_CODE_CHARS) throw new Error(`The effect code is ${code.length} characters; the limit is ${MAX_SKIN_CODE_CHARS}.`);
  if (!/\bfunction\s+draw\s*\(|\bdraw\s*=/.test(code)) throw new Error("The effect code must define draw(ctx, s, dt).");
  const dir = skinDir(skin.slug);
  mkdirSync(dir, { recursive: true });
  writeValidatedFile(join(dir, SKIN_CODE_FILE), code);
  const base = skin.effect ?? { density: 1, speed: 1, size: 1, reactive: false };
  return stamped(skin, { code: SKIN_CODE_FILE, effect: { ...base, kind: "custom" } });
}

/** Remove a whole skin: its folder goes to the trash (recoverable there),
 *  and a tombstone tells the user's other machines to drop their copy. */
export async function removeSkin(ref: string): Promise<Skin> {
  const skin = known(ref);
  const trashed = await moveToTrash(skinDir(skin.slug), `skin_remove:${skin.slug}`);
  if (!trashed && existsSync(skinDir(skin.slug))) throw new Error(`Theme "${skin.name}" could not be moved to the trash.`);
  tombstoneLibraryItemEagerly(getLaxDir(), "skins", skin.slug);
  return skin;
}
