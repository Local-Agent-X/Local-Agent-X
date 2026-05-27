/**
 * Protocol Builder — create/edit/delete custom protocols programmatically.
 *
 * Storage: workspace/protocols/custom.json. Lives under workspace so the
 * file is picked up by the workspace git sync — protocols learned on one
 * machine flow to all of the user's other machines. Previously stored at
 * ~/.lax/custom-protocols.json (local-only); first load migrates that
 * file to the new location if present.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Protocol, ProtocolStep } from "../protocols.js";
import { getLaxDir } from "../lax-data-dir.js";
import type { ToolDefinition } from "../types.js";
import { getRuntimeConfig } from "../config.js";

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
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}

export function saveCustomProtocols(protocols: Protocol[]): void {
  migrateLegacyCustomProtocols();
  writeFileSync(customProtocolsPath(), JSON.stringify(protocols, null, 2), "utf-8");
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
  protocols[idx] = { ...protocols[idx], ...updates, name: updates.name ?? protocols[idx].name };
  saveCustomProtocols(protocols);
  return protocols[idx];
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

export function createBuilderTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_create",
      description:
        "Create a new custom protocol with steps, rules, and triggers. " +
        "Refuses to create near-duplicates of existing protocols (cosine similarity > 0.85 on name+description+triggers). " +
        "If you intentionally want to replace an existing similar protocol, pass `supersedes: \"<existing-name>\"` — that bypasses the dedup check and auto-deletes the old one.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique protocol name" },
          description: { type: "string", description: "What this protocol does" },
          triggers: { type: "array", items: { type: "string" }, description: "Phrases that activate this protocol" },
          steps: { type: "array", items: { type: "object" }, description: "Array of ProtocolStep objects" },
          rules: { type: "array", items: { type: "string" }, description: "Rules to follow during execution" },
          supersedes: { type: "string", description: "Name of an existing protocol this replaces. Bypasses dedup; deletes the named target." },
        },
        required: ["name", "description", "triggers", "steps"],
      },
      async execute(args) {
        try {
          const name = String(args.name);
          const description = String(args.description);
          const triggers = (args.triggers as string[]) || [];
          const supersedes = typeof args.supersedes === "string" ? args.supersedes : undefined;

          // Dedup check — refuse near-duplicates unless the caller explicitly
          // names what they're replacing. Soft-degrades to no-op if the
          // embedding provider isn't available (memory init didn't run).
          if (!supersedes) {
            const { findDuplicate } = await import("./dedup.js");
            const { getAllProtocols } = await import("../protocols.js");
            const dup = await findDuplicate(
              { name, description, triggers },
              getAllProtocols(),
            );
            if (dup) {
              return {
                content:
                  `Refused: protocol "${name}" is too similar to existing "${dup.name}" ` +
                  `(cosine similarity ${dup.similarity.toFixed(2)}). ` +
                  `Either use \`protocol_edit\` to update "${dup.name}", or re-call with ` +
                  `\`supersedes: "${dup.name}"\` to replace it.`,
                isError: true,
                metadata: { recovery: "Edit the existing protocol or pass supersedes to replace it." },
              };
            }
          }

          const protocol = createProtocol({
            name,
            description,
            triggers,
            steps: args.steps as ProtocolStep[],
            rules: (args.rules as string[]) || [],
            learnablePreferences: [],
            ...(supersedes ? { supersedes } : {}),
          });

          // If superseding, drop the old protocol + its embedding cache entry.
          let supersededNote = "";
          if (supersedes) {
            try {
              const removed = deleteProtocol(supersedes);
              const { dropEmbedding } = await import("./dedup.js");
              dropEmbedding(supersedes);
              supersededNote = removed ? ` Replaced "${supersedes}".` : ` (Note: "${supersedes}" not found.)`;
            } catch (e) {
              supersededNote = ` (Failed to remove "${supersedes}": ${(e as Error).message})`;
            }
          }

          try {
            const { recordUsage } = await import("./usage.js");
            recordUsage({
              action: "built",
              name: protocol.name,
              sessionId: typeof (args as { _sessionId?: string })._sessionId === "string" ? (args as { _sessionId: string })._sessionId : undefined,
            });
          } catch { /* telemetry never fails the call */ }
          return { content: `Created protocol "${protocol.name}" with ${protocol.steps.length} steps.${supersededNote}` };
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
        "Soft-delete a custom protocol — moves it to the archive (recoverable via protocol_unarchive). " +
        "Pass `permanent: true` to hard-delete immediately (irrecoverable; drops the embedding cache entry). " +
        "Archived protocols don't appear in protocol_search or protocol_list. " +
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
        const rec = archiveProtocol(name, reason);
        if (!rec) {
          return {
            content: `Protocol "${name}" not found in active catalog. (Already archived? Use protocol_unarchive to restore.)`,
            isError: true,
          };
        }
        return { content: `Archived protocol "${name}". Use protocol_unarchive to restore within 30 days.` };
      },
    },
    {
      name: "protocol_unarchive",
      description:
        "Restore an archived protocol back to the active catalog. " +
        "Fails if a live protocol of the same name already exists — either rename the conflict or remove it first.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Archived protocol name to restore" },
        },
        required: ["name"],
      },
      async execute(args) {
        const name = String(args.name);
        const { unarchiveProtocol } = await import("./archive.js");
        const result = unarchiveProtocol(name);
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
      description: "List archived protocols (soft-deleted, recoverable). Shows when each was archived and why.",
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
            return `- ${r.protocol.name} (archived ${daysAgo}d ago)${why}`;
          });
        return { content: `Archived protocols (${archived.length}):\n${lines.join("\n")}\n\nRestore with \`protocol_unarchive { name }\`.` };
      },
    },
  ];
}
