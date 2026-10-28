// One pass over a project's documents: index what is new or changed, drop
// what is gone. A file is re-read only when its size or mtime moved (kept in
// the files table, under the document's virtual path); the chunk writes are
// content-hash idempotent, so an unchanged passage is never re-embedded.

import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { MemoryIndex } from "../index-core.js";
import type { Chunk } from "../types.js";
import { chunkText } from "../chunking.js";
import { forgetDocumentText, saveDocumentText } from "./full-text.js";
import { isSensitivePath } from "../../data-lineage/paths.js";
import { createLogger } from "../../logger.js";
import { projectDocPath, projectDocPathPrefix } from "./paths.js";
import { agentMayRead, projectDocsFolders, type DocsFolder, type ProjectLike } from "./folders.js";
import { documentText, isDocumentFile } from "./extract.js";

const logger = createLogger("memory.project-docs");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "venv", "__pycache__"]);
/** A scanned PDF can be large; past this a file is not indexed. */
export const MAX_DOC_FILE_BYTES = 25 * 1024 * 1024;
/** Bounds one project's walk, so a folder pointed at a whole drive stays a
 *  bounded job. Files past it are reported, not indexed. */
export const MAX_DOCS_PER_PROJECT = 2000;

export interface DocsPassReport {
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: string[];
}

interface FoundDoc {
  file: string;
  virtualPath: string;
  stamp: string;
}

/** Every document file under `folder`, symlinks and dot-folders not followed. */
function walk(folder: DocsFolder, projectId: string, found: FoundDoc[], skipped: string[]): void {
  const stack = [folder.dir];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; } // vanished or unreadable mid-walk
    for (const name of names) {
      const file = join(dir, name);
      let st;
      try { st = lstatSync(file); } catch { continue; } // vanished mid-walk
      if (st.isSymbolicLink() || name.startsWith(".")) continue;
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) stack.push(file); continue; }
      if (!st.isFile() || !isDocumentFile(file) || isSensitivePath(file)) continue;
      if (st.size > MAX_DOC_FILE_BYTES) { skipped.push(`${file} (over ${MAX_DOC_FILE_BYTES / 1024 / 1024} MB)`); continue; }
      if (found.length >= MAX_DOCS_PER_PROJECT) { skipped.push(`${file} (past ${MAX_DOCS_PER_PROJECT} documents)`); continue; }
      const rel = relative(folder.dir, file);
      found.push({ file, virtualPath: projectDocPath(projectId, `${folder.label}/${rel}`), stamp: `${st.mtimeMs}:${st.size}` });
    }
  }
}

function indexedPaths(memory: MemoryIndex, projectId: string): Map<string, string> {
  const prefix = projectDocPathPrefix(projectId);
  const rows = memory["db"].prepare("SELECT path, hash FROM files WHERE substr(path, 1, ?) = ?")
    .all(prefix.length, prefix) as Array<{ path: string; hash: string }>;
  return new Map(rows.map((r) => [r.path, r.hash]));
}

async function indexDoc(memory: MemoryIndex, doc: FoundDoc): Promise<void> {
  const text = await documentText(doc.file);
  const { maxChunkChars, overlapChars } = memory.getChunkConfig();
  const chunks = chunkText(text, doc.virtualPath, "project-doc", maxChunkChars, overlapChars, { file_path: doc.file }) as Chunk[];
  await memory.indexChunksIdempotent(chunks, doc.virtualPath, "project-doc");
  saveDocumentText(memory, doc.virtualPath, doc.file, text);
  const [mtime, size] = doc.stamp.split(":").map(Number);
  memory["db"].prepare("INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, 'project-doc', ?, ?, ?)")
    .run(doc.virtualPath, doc.stamp, mtime, size);
}

function removeDoc(memory: MemoryIndex, path: string): void {
  memory.removeFile(path);
  forgetDocumentText(memory, path);
}

/** Bring the index in line with the project's folders. */
export async function indexProjectDocs(memory: MemoryIndex, project: ProjectLike): Promise<DocsPassReport> {
  const report: DocsPassReport = { indexed: 0, unchanged: 0, removed: 0, skipped: [] };
  const found: FoundDoc[] = [];
  for (const folder of projectDocsFolders(project)) {
    if (!agentMayRead(folder.dir)) {
      report.skipped.push(`${folder.dir} (the agent's file access does not reach it)`);
      continue;
    }
    walk(folder, project.id, found, report.skipped);
  }
  const before = indexedPaths(memory, project.id);
  for (const doc of found) {
    if (before.get(doc.virtualPath) === doc.stamp) { report.unchanged++; continue; }
    try {
      await indexDoc(memory, doc);
      report.indexed++;
    } catch (e) {
      report.skipped.push(`${doc.file} (${(e as Error).message})`);
    }
  }
  const present = new Set(found.map((d) => d.virtualPath));
  for (const path of before.keys()) {
    if (!present.has(path)) { removeDoc(memory, path); report.removed++; }
  }
  if (report.skipped.length) logger.info(`[project-docs] ${project.id}: skipped ${report.skipped.length}: ${report.skipped.slice(0, 5).join("; ")}`);
  return report;
}

/** Drop every document of a project that no longer exists. */
export function removeProjectDocs(memory: MemoryIndex, projectId: string): number {
  const paths = [...indexedPaths(memory, projectId).keys()];
  for (const path of paths) removeDoc(memory, path);
  return paths.length;
}

/** The ids of every project with documents in the index. */
export function indexedProjectIds(memory: MemoryIndex): string[] {
  const rows = memory["db"].prepare("SELECT DISTINCT path FROM files WHERE source = 'project-doc'").all() as Array<{ path: string }>;
  return [...new Set(rows.map((r) => r.path.split("/")[1]).filter(Boolean))];
}
