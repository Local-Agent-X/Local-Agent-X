/**
 * The workspace files an assistant reply names, resolved once on the desktop and
 * sent with the turn (the `done` event's `files`, a history reply's `_files`), so a
 * device draws what the desktop resolved instead of guessing at paths in the text.
 *
 * A reply names a file the way agents write them: `workspace/x/y.png`, a full path
 * (C:\…\workspace\…, /c/…), a markdown link or image to either, a /files address, or
 * a name alone in a code span after the reply named its folder (2026-11-26: six
 * images listed by name under one `workspace/black-friday-sale/` line). Each is
 * resolved by the resolver the file tools use (resolveAgentPathFrom), kept only when
 * it is an existing file of a type a device shows or opens, and never a credential
 * file the device's tunnel would refuse (device-paths.ts). A file in the workspace
 * is a /files address; one outside it (a photo in Pictures) a /local-files address,
 * when the rule for those allows it (server/local-files.ts).
 *
 * The desktop chat links the same text itself (public/js/shared-md.js md()), where
 * the links sit in the sentence; test/named-files-seam.test.ts holds the two to the
 * same files.
 */
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { workspaceRoot } from "../config.js";
import { isSensitivePath } from "../data-lineage/index.js";
import type { TurnFileKind, TurnFileRef } from "../broker-transport/vendor/turn-files.js";
import { resolveAgentPathFrom } from "./paths.js";
import { localFileRefusal, localFilesAddress } from "../server/local-files.js";

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(?:mp4|webm)$/i;
const NAMED_EXT = /\.(?:docx?|xlsx?|pptx?|pdf|csv|md|markdown|txt|json|rtf|png|jpe?g|gif|webp|mp4|webm|mp3|wav|m4a|ogg|zip)$/i;

// In reading order: a markdown link or image (1 label, 2 target), a code span (3),
// a bare workspace/ path (4), or a /files address, bare or as this app's full URL (5).
const NAMED = /!?\[([^\]\n]*)\]\(\s*([^)\n]+?)\s*\)|`([^`\n]+)`|(?<![\w./\\-])((?:\.\/)?workspace[\\/][^\s)`"'<>]+)|(?<![\w.-])((?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/files\/[^\s)`"'<>]+)/g;

/** The /files/<path> address of a path inside the workspace, each segment encoded;
 *  undefined for a path outside it. */
export function workspaceFilesAddress(workspace: string, absPath: string): string | undefined {
  const rel = relative(workspace, absPath);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return undefined;
  return "/files/" + rel.split(sep).map(encodeURIComponent).join("/");
}

function kindOf(name: string): TurnFileKind {
  return IMAGE_EXT.test(name) ? "image" : VIDEO_EXT.test(name) ? "video" : "file";
}

/** What a written reference names on disk: an absolute path, or null when it is
 *  not a file path at all (a web address, a word in a code span). */
function pathOf(workspace: string, written: string): string | null {
  const ref = written.replace(/[.,;:!?]+$/, "");
  const files = /^(?:https?:\/\/[^/]+)?\/files\/(.+)$/.exec(ref);
  if (files) {
    try { return resolveAgentPathFrom(workspace, decodeURIComponent(files[1].split(/[?#]/)[0])); } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) && !/^file:\/\/\//i.test(ref)) return null;
  const local = ref.replace(/^file:\/\/\//i, "");
  if (/^(?:\.\/)?workspace[\\/]/i.test(local) || /^(?:[A-Za-z]:[\\/]|\/[A-Za-z]\/|\/|~[\\/])/.test(local)) {
    return resolveAgentPathFrom(workspace, local);
  }
  return null;
}

export interface NamedFilesOptions {
  /** The workspace root; the configured one by default. */
  workspace?: string;
  /** Whether an absolute path is an existing file; the disk by default. */
  isFile?: (absPath: string) => boolean;
  /** Whether a device may open a file outside the workspace; by default the one
   *  rule for that (server/local-files.ts: the agent's read gate and more). */
  reachesOutside?: (absPath: string) => boolean;
}

const isFileOnDisk = (absPath: string): boolean => {
  try { return statSync(absPath).isFile(); } catch { return false; }
};

/** The workspace files `reply` names, in the order it names them, each once. */
export function filesNamedInReply(reply: string, opts: NamedFilesOptions = {}): TurnFileRef[] {
  const workspace = resolve(opts.workspace ?? workspaceRoot());
  const isFile = opts.isFile ?? isFileOnDisk;
  const reachesOutside = opts.reachesOutside ?? ((abs: string) => localFileRefusal(abs) === null);
  const found: TurnFileRef[] = [];
  const seen = new Set<string>();
  // The folder the reply named last: a name alone in a code span is a file there.
  const named: { folder: string | null } = { folder: null };
  const take = (abs: string): void => {
    if (abs === workspace) { named.folder = workspace; return; }
    const inside = workspaceFilesAddress(workspace, abs);
    if (!NAMED_EXT.test(abs)) {
      if (!/\.[A-Za-z0-9]{1,5}$/.test(abs)) named.folder = abs;
      return;
    }
    named.folder = dirname(abs);
    // A file outside the workspace is a device's to open only where the one rule
    // for that says so (the agent's own read gate, and no credential file).
    const address = inside ?? (reachesOutside(abs) ? localFilesAddress(abs) : undefined);
    if (address === undefined || seen.has(address)) return;
    if (inside !== undefined && (!isFile(abs) || isSensitivePath(relative(workspace, abs)))) return;
    seen.add(address);
    const name = basename(abs);
    found.push({ path: address, name, kind: kindOf(name) });
  };
  for (const m of reply.matchAll(NAMED)) {
    const abs = pathOf(workspace, m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");
    if (abs !== null) take(abs);
    else if (m[3] !== undefined && named.folder !== null && /^[^\s/\\]+$/.test(m[3]) && NAMED_EXT.test(m[3])) take(join(named.folder, m[3]));
  }
  return found;
}
