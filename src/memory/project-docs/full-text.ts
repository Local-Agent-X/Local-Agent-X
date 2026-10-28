// A project small enough to fit gets its documents in full. While every
// document of the chat's project fits in PROJECT_DOCS_FULL_SHARE of the
// model's context window, the prompt carries all of them, word for word;
// past that, the agent works from search (memory_search and per-turn recall),
// which keeps running either way. The window is the model's real one
// (resolved per model, a local runtime's measured num_ctx), so the same rule
// loads hundreds of pages on a large cloud window and a few dozen locally.
//
// The text is the extract the indexer made (project_doc_text, schema v20),
// so building a turn never re-reads or re-parses a file.

import type { MemoryIndex } from "../index-core.js";
import { lookupContextWindow } from "../../context-manager/model-windows.js";
import { estimateTokens } from "../../context-manager/token-estimation.js";
import { getSessionProject } from "../../session/project.js";
import { personalDocumentPath } from "../../tool-execution/private-read-record.js";
import { recordPrivateRead } from "../../data-lineage/private-content.js";
import { projectDocPathPrefix } from "./paths.js";

/** The share of the model's window a project's documents may fill. */
export const PROJECT_DOCS_FULL_SHARE = 0.25;

export interface FullDocument {
  /** The virtual path the index keys it by (project/<id>/docs/<rel>). */
  path: string;
  /** The file on disk. */
  file: string;
  text: string;
}

export function saveDocumentText(memory: MemoryIndex, path: string, file: string, text: string): void {
  memory["db"].prepare("INSERT OR REPLACE INTO project_doc_text (path, file, text) VALUES (?, ?, ?)").run(path, file, text);
}

export function forgetDocumentText(memory: MemoryIndex, path: string): void {
  memory["db"].prepare("DELETE FROM project_doc_text WHERE path = ?").run(path);
}

/** Every document of the project, when all of them fit in `budgetTokens`;
 *  null when they do not, or when there are none. */
export function projectDocumentsInFull(memory: MemoryIndex, projectId: string, budgetTokens: number): FullDocument[] | null {
  const prefix = projectDocPathPrefix(projectId);
  const docs = memory["db"].prepare("SELECT path, file, text FROM project_doc_text WHERE substr(path, 1, ?) = ? ORDER BY path")
    .all(prefix.length, prefix) as FullDocument[];
  if (docs.length === 0) return null;
  let tokens = 0;
  for (const doc of docs) {
    tokens += estimateTokens(doc.text);
    if (tokens > budgetTokens) return null;
  }
  return docs;
}

function renderDocuments(docs: readonly FullDocument[]): string {
  const body = docs.map((d) =>
    // A document cannot close its own element.
    `<document file=${JSON.stringify(d.file)}>\n${d.text.replace(/<\/document/gi, "</ document")}\n</document>`,
  ).join("\n\n");
  return `<project_documents_in_full>\n` +
    `[provenance source=project-doc source_type=project-file trust=untrusted taint=unknown label="Project documents"]\n` +
    `Every document of this project, complete (${docs.length} file${docs.length === 1 ? "" : "s"}). ` +
    `Answer from them directly; memory_search is not needed to find text in them.\n\n${body}\n</project_documents_in_full>`;
}

/**
 * The prompt section for a session's project documents, or "" when the
 * session is not in a project or its documents do not fit `model`'s share.
 * A document from the user's own folders is recorded as a private read, as
 * it is when search returns a passage of it (private-reads.ts).
 */
export function projectDocumentsSection(memory: MemoryIndex, sessionId: string, model: string): string {
  const projectId = getSessionProject(sessionId);
  if (!projectId) return "";
  const docs = projectDocumentsInFull(memory, projectId, Math.floor(lookupContextWindow(model) * PROJECT_DOCS_FULL_SHARE));
  if (!docs) return "";
  for (const doc of docs) {
    const personal = personalDocumentPath(doc.file, sessionId);
    if (personal) recordPrivateRead(sessionId, { label: personal, key: personal }, doc.text);
  }
  return renderDocuments(docs);
}
