/**
 * Protocol Builder — create/edit/delete custom protocols programmatically.
 *
 * Storage: workspace/protocols/custom.json. Lives under workspace so the
 * file is picked up by the workspace git sync — protocols learned on one
 * machine flow to all of the user's other machines. Previously stored at
 * ~/.lax/custom-protocols.json (local-only); first load migrates that
 * file to the new location if present.
 */

import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Protocol, ProtocolStep } from "../protocols/index.js";
import { authorProtocol } from "./authoring.js";
import { noteCatalogReadFailure } from "./loader.js";
import { getLaxDir } from "../lax-data-dir.js";
import type { ToolDefinition } from "../types.js";
import { getRuntimeConfig } from "../config.js";
import { atomicWriteFileSync } from "../util/json-store.js";
import { invalidateSearchIndex } from "./search.js";

import { createLogger } from "../logger.js";
const logger = createLogger("protocols.builder");

/** Resolve the workspace/protocols dir (creates it if missing). */
function protocolsDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "protocols");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function customProtocolsPath(): string {
  return join(protocolsDir(), "custom.json");
}

const LEGACY_PATH = join(getLaxDir(), "custom-protocols.json");
let _migrationRan = false;

/** One-time migration: ~/.lax/custom-protocols.json → workspace/protocols/custom.json.
 *  Idempotent — after the first successful move the legacy file is gone and
 *  this becomes a no-op. */
function migrateLegacyCustomProtocols(): void {
  if (_migrationRan) return;
  _migrationRan = true;
  try {
    if (!existsSync(LEGACY_PATH)) return;
    const newPath = customProtocolsPath();
    if (existsSync(newPath)) return; // workspace already has one — keep it, don't clobber
    renameSync(LEGACY_PATH, newPath);
    logger.info(`[protocols] Migrated custom protocols → ${newPath}`);
  } catch (e) {
    logger.warn(`[protocols] Legacy migration failed: ${(e as Error).message}`);
  }
}

export function loadCustomProtocols(): Protocol[] {
  migrateLegacyCustomProtocols();
  const path = customProtocolsPath();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      // Parseable but not a Protocol[] — an object, a string, `null`. Nothing
      // downstream survives it: stampCustomSource() does `records.map(...)` and
      // throws "records.map is not a function", which takes down getAllProtocols()
      // and with it the whole authoring path. Same class as the parse failure
      // below (a hand-edited or half-synced file), so it degrades the same way
      // and is counted the same way — a destructive reconciler must not read
      // this as "the user has no custom protocols".
      if (!Array.isArray(parsed)) {
        noteCatalogReadFailure();
        return [];
      }
      return parsed;
    } catch {
      // Degrading to [] is right for a read — a half-synced file or a git
      // merge-conflict blob must not take the app down. But the result is
      // now indistinguishable from "the user has no custom protocols", and
      // custom.json is workspace-git-synced, so that state is reachable in
      // normal use. Record it so destructive reconcilers can tell.
      noteCatalogReadFailure();
      return [];
    }
  }
  return [];
}

/**
 * The single write choke point for custom.json — every create/edit/delete, the
 * archive/unarchive moves, and the marketplace installer land here.
 *
 * Atomic (tmp + rename) because this file now has more than one writer: a
 * background review fork authors protocols while a foreground tool or the user
 * may be writing too. A torn write is worse than a lost one here —
 * loadCustomProtocols() swallows a parse failure as `[]`, so a half-written
 * file reads back as "the user has no custom protocols" and the very next save
 * persists that emptiness.
 *
 * Dropping the search index here is what makes an in-place EDIT discoverable.
 * The index only rebuilt when the protocol COUNT changed, so rewording or
 * re-triggering a protocol was invisible to protocol(action:'search') for the
 * rest of the process's life.
 */
export function saveCustomProtocols(protocols: Protocol[]): void {
  migrateLegacyCustomProtocols();
  atomicWriteFileSync(customProtocolsPath(), JSON.stringify(protocols, null, 2), { encoding: "utf-8" });
  invalidateSearchIndex();
}

export function createProtocol(protocol: Protocol): Protocol {
  const protocols = loadCustomProtocols();
  if (protocols.find(m => m.name === protocol.name)) {
    throw new Error(`Protocol "${protocol.name}" already exists`);
  }
  protocols.push(protocol);
  saveCustomProtocols(protocols);
  return protocol;
}

export function editProtocol(name: string, updates: Partial<Protocol>): Protocol {
  const protocols = loadCustomProtocols();
  const idx = protocols.findIndex(m => m.name === name);
  if (idx === -1) throw new Error(`Protocol "${name}" not found`);
  const before = protocols[idx];
  const after = { ...before, ...updates, name: updates.name ?? before.name };
  protocols[idx] = after;
  saveCustomProtocols(protocols);

  // The dedup embedding is keyed by name and derived from name + description +
  // triggers. An edit to any of those leaves the cached vector describing text
  // that no longer exists — and a rename orphans it under a key nothing will
  // ever refresh. Drop the pre-edit key so the next dedup pass re-embeds.
  // Lazy import for the same reason as deleteProtocol below.
  void import("./dedup.js").then((m) => {
    if (m.dedupTextOf(before) !== m.dedupTextOf(after)) m.dropEmbedding(before.name);
  }).catch(() => { /* best-effort — dedup is a soft dependency */ });

  return after;
}

export function deleteProtocol(name: string): boolean {
  const protocols = loadCustomProtocols();
  const idx = protocols.findIndex(m => m.name === name);
  if (idx === -1) return false;
  protocols.splice(idx, 1);
  saveCustomProtocols(protocols);
  // Best-effort: drop the cached embedding so the sidecar doesn't drift.
  // Lazy import avoids a cycle (dedup → protocols → builder → dedup).
  void import("./dedup.js").then((m) => m.dropEmbedding(name)).catch(() => { /* swallow */ });
  return true;
}

export function getProtocol(name: string): Protocol | undefined {
  return loadCustomProtocols().find(m => m.name === name);
}

// The authoring path (dedup + provenance + markdown body) lives in
// authoring.ts — this file owns persistence. Re-exported so every existing
// `from "./builder.js"` import site keeps working.
export {
  authorProtocol,
  type AuthorProtocolInput,
  type AuthorProtocolResult,
} from "./authoring.js";

export function createBuilderTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_create",
      description:
        "Create a new custom protocol with steps, rules, and triggers. " +
        "Refuses to create near-duplicates of existing protocols (cosine similarity > 0.85 on name+description+triggers). " +
        "If you intentionally want to replace an existing similar protocol, pass `supersedes: \"<existing-name>\"` — that bypasses the dedup check and archives the old one (recoverable via protocol(action:'unarchive')).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique protocol name" },
          description: { type: "string", description: "What this protocol does" },
          triggers: { type: "array", items: { type: "string" }, description: "Phrases that activate this protocol" },
          steps: { type: "array", items: { type: "object" }, description: "Array of ProtocolStep objects" },
          rules: { type: "array", items: { type: "string" }, description: "Rules to follow during execution" },
          body: { type: "string", description: "Optional markdown body. Preferred over `steps` when the protocol reads as prose; protocol(action:'get') returns it in place of the step list." },
          supersedes: { type: "string", description: "Name of an existing protocol this replaces. Bypasses dedup; archives the named target (recoverable, not deleted)." },
        },
        required: ["name", "description", "triggers", "steps"],
      },
      async execute(args) {
        try {
          const result = await authorProtocol({
            name: String(args.name),
            description: String(args.description),
            triggers: (args.triggers as string[]) || [],
            steps: args.steps as ProtocolStep[],
            rules: (args.rules as string[]) || [],
            body: typeof args.body === "string" ? args.body : undefined,
            supersedes: typeof args.supersedes === "string" ? args.supersedes : undefined,
            sessionId: typeof (args as { _sessionId?: string })._sessionId === "string" ? (args as { _sessionId: string })._sessionId : undefined,
          });

          if (!result.ok) {
            const dup = result.duplicate;
            return {
              content:
                `Refused: protocol "${String(args.name)}" is too similar to existing "${dup.name}" ` +
                `(cosine similarity ${dup.similarity.toFixed(2)}). ` +
                `Either use \`protocol(action:'edit')\` to update "${dup.name}", or re-call with ` +
                `\`supersedes: "${dup.name}"\` to replace it.`,
              isError: true,
              metadata: { recovery: "Edit the existing protocol or pass supersedes to replace it." },
            };
          }
          return { content: `Created protocol "${result.protocol.name}" with ${result.protocol.steps.length} steps.${result.supersededNote}` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "protocol_edit",
      description: "Edit an existing custom protocol.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name to edit" },
          updates: { type: "object", description: "Partial protocol fields to update" },
        },
        required: ["name", "updates"],
      },
      async execute(args) {
        try {
          const updated = editProtocol(String(args.name), args.updates as Partial<Protocol>);
          return { content: `Updated protocol "${updated.name}".` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "protocol_delete",
      description:
        "Soft-delete a custom protocol — moves it to the archive (recoverable via protocol(action:'unarchive')). " +
        "Pass `permanent: true` to hard-delete immediately (irrecoverable; drops the embedding cache entry). " +
        "Archived protocols don't appear in protocol(action:'search') or protocol(action:'list'). " +
        "Archive purge is automatic after 30 days unless restored.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name to delete" },
          reason: { type: "string", description: "Optional reason recorded with the archive entry" },
          permanent: { type: "boolean", description: "If true, skip archive and hard-delete. Default false." },
        },
        required: ["name"],
      },
      async execute(args) {
        const name = String(args.name);
        const permanent = (args as { permanent?: boolean }).permanent === true;
        if (permanent) {
          const removed = deleteProtocol(name);
          return { content: removed ? `Hard-deleted protocol "${name}".` : `Protocol "${name}" not found.` };
        }
        const { archiveProtocol } = await import("./archive.js");
        const reason = typeof (args as { reason?: string }).reason === "string" ? (args as { reason?: string }).reason : undefined;
        let rec: Awaited<ReturnType<typeof archiveProtocol>>;
        try {
          rec = archiveProtocol(name, reason);
        } catch (e) {
          // An unreadable archive. Report it as itself — the one thing this
          // path must never do is turn a storage failure into "not found".
          return { content: (e as Error).message, isError: true };
        }
        if (!rec) {
          // null now means exactly one thing: the name isn't in custom.json.
          // It used to ALSO mean "already archived, and I just deleted the live
          // copy to resolve that" — a claim the call itself made true.
          return {
            content: `Protocol "${name}" isn't in the editable catalog, so there was nothing to archive. (Built-in/bundled/imported protocols can't be archived. Use protocol(action:'list_archived') to see what's already in the archive.)`,
            isError: true,
          };
        }
        return { content: `Archived protocol "${name}". Use protocol(action:'unarchive') to restore within 30 days.` };
      },
    },
    {
      name: "protocol_unarchive",
      description:
        "Restore an archived protocol back to the active catalog. Restores the most recent archived " +
        "version of that name; pass `archivedTs` (from protocol(action:'list_archived')) to restore an " +
        "older one. Fails if a live protocol of the same name already exists — archive that one first " +
        "(archiving never destroys anything), then restore.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Archived protocol name to restore" },
          archivedTs: { type: "integer", description: "Optional: the exact archive timestamp to restore, when several versions of the name are archived. Defaults to the newest." },
        },
        required: ["name"],
      },
      async execute(args) {
        const name = String(args.name);
        const rawTs = (args as { archivedTs?: unknown }).archivedTs;
        const archivedTs = typeof rawTs === "number" && Number.isFinite(rawTs) ? rawTs : undefined;
        const { unarchiveProtocol } = await import("./archive.js");
        const result = unarchiveProtocol(name, { archivedTs });
        if (result.error) return { content: result.error, isError: true };
        return { content: `Restored protocol "${name}" with ${result.restored?.steps.length ?? 0} steps.` };
      },
    },
    {
      name: "protocol_pin",
      description:
        "Pin or unpin a custom protocol. Pinned protocols are exempt from automatic archive/purge transitions — " +
        "use this for rarely-used-but-critical workflows that shouldn't decay just because they don't fire often.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name" },
          pinned: { type: "boolean", description: "true to pin, false to unpin. Default true." },
        },
        required: ["name"],
      },
      async execute(args) {
        const name = String(args.name);
        const pinned = (args as { pinned?: boolean }).pinned === false ? false : true;
        try {
          const updated = editProtocol(name, { pinned });
          return { content: `${pinned ? "Pinned" : "Unpinned"} protocol "${updated.name}".` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "protocol_list_archived",
      description:
        "List archived protocols (soft-deleted, recoverable). Shows when each was archived and why. " +
        "A name can appear more than once — the archive keeps every version — and `archivedTs` is what " +
        "tells them apart when restoring.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const { loadArchived } = await import("./archive.js");
        const archived = loadArchived();
        if (archived.length === 0) return { content: "No archived protocols." };
        const lines = archived
          .sort((a, b) => b.archivedTs - a.archivedTs)
          .map((r) => {
            const daysAgo = Math.floor((Date.now() - r.archivedTs) / 86_400_000);
            const why = r.reason ? ` — ${r.reason}` : "";
            return `- ${r.protocol.name} (archived ${daysAgo}d ago, archivedTs ${r.archivedTs})${why}`;
          });
        return { content: `Archived protocols (${archived.length}):\n${lines.join("\n")}\n\nRestore with \`protocol({action: "unarchive", params: {name}})\`.` };
      },
    },
  ];
}
