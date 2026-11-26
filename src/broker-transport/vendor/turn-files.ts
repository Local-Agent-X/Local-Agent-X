// The workspace files an assistant reply names, resolved once by the desktop: each one a
// /files address its tunnel serves, the name to show, and whether a device shows it in
// the reply (a picture, a video) or as a file to open. The desktop sends the list on a
// turn's `done` event and as `_files` on each reply of a reloaded history (LAX
// src/workspace/named-files.ts), so a device draws what the desktop resolved instead of
// guessing at paths in the text. A desktop that predates it sends none.

import { asRecord, asString } from "./guards.js";

/** How a device shows the file. A kind a device does not know is shown as a file. */
export type TurnFileKind = "image" | "video" | "file";
const KINDS: readonly string[] = ["image", "video", "file"];

export type TurnFileRef = {
  /** The file's /files/<path> address, each segment URI-encoded. */
  path: string;
  name: string;
  kind: TurnFileKind;
};

function parseRef(raw: unknown): TurnFileRef | null {
  const r = asRecord(raw);
  const path = asString(r?.path);
  const name = asString(r?.name);
  if (path === null || name === null || !path.startsWith("/files/")) return null;
  const kind = asString(r?.kind);
  return { path, name, kind: kind !== null && KINDS.includes(kind) ? (kind as TurnFileKind) : "file" };
}

/** A reply's resolved files, or null when the value carries none (absent, not a list). */
export function parseTurnFiles(raw: unknown): TurnFileRef[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(parseRef).filter((ref): ref is TurnFileRef => ref !== null);
}
