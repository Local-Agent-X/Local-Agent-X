// A project document that sits in the user's own folders (a project linked
// to Documents\ClientX, say) is private content, exactly as it is when the
// agent opens it with a file tool (tool-execution/private-read-record.ts).
// What search puts in front of the model is recorded the same way, so a later
// send of that text to someone new is put to the user. Documents in the
// project's own folder inside the agent's workspace are the agent's working
// files and are not recorded, the same exemption a read gets.

import type { MemorySearchResult } from "../types.js";
import { personalDocumentPath } from "../../tool-execution/private-read-record.js";
import { recordPrivateRead } from "../../data-lineage/private-content.js";

export function recordProjectDocReads(sessionId: string | undefined, results: readonly MemorySearchResult[], delivered: (r: MemorySearchResult) => string): void {
  if (!sessionId) return;
  for (const r of results) {
    if (r.source !== "project-doc") continue;
    const doc = personalDocumentPath(r.metadata?.file_path, sessionId);
    if (doc) recordPrivateRead(sessionId, { label: doc, key: doc }, delivered(r));
  }
}
