/**
 * Protocol authoring — the full "write a new protocol" path.
 *
 * Split from builder.ts, which owns persistence (load/save custom.json plus
 * the create/edit/delete primitives on top of it). Those primitives are raw:
 * createProtocol() writes and nothing else — no similarity check, no
 * provenance. Only the protocol_create tool ever brought its own gate, which
 * is why a programmatic caller had to choose between dedup and a markdown
 * body: the gate lived inside the tool wrapper and the tool's schema had no
 * `body`.
 *
 * authorProtocol() is the one authoring path — dedup, then write, then
 * provenance — and the protocol_create tool is now a thin adapter over it, so
 * "author a protocol" has a single implementation instead of two that drift.
 *
 * builder.ts re-exports everything here, so existing import sites are
 * unchanged.
 */
import type { Protocol, ProtocolSource, ProtocolStep } from "../protocols/index.js";
import type { DuplicateMatch } from "./dedup.js";
import { createProtocol } from "./builder.js";

export interface AuthorProtocolInput {
  name: string;
  description: string;
  triggers: string[];
  /** Typed steps. Optional — a markdown `body` alone is a complete protocol,
   *  and protocol(action:'get') prefers body over steps. */
  steps?: ProtocolStep[];
  rules?: string[];
  /** Markdown body. The reason this entry point exists: protocol_create's
   *  schema had no `body`, so a caller could have the dedup gate or a markdown
   *  body, never both. */
  body?: string;
  tags?: string[];
  category?: string;
  /** Existing protocol this replaces. Bypasses dedup and ARCHIVES the target
   *  (recoverable via protocol(action:'unarchive')), never hard-deletes it. */
  supersedes?: string;
  /** Who wrote this. Absent means UNKNOWN authorship and is persisted as
   *  absent — never defaulted to "user", which would mislabel the entire
   *  pre-provenance catalog as the user's own work. */
  authoredBy?: "agent" | "user";
  /** Defaults to now when `authoredBy` is set; ignored otherwise. */
  authoredAt?: number;
  authoredFromSession?: string;
  /** Session recorded on the "built" telemetry event. */
  sessionId?: string;
}

export type AuthorProtocolResult =
  | { ok: true; protocol: Protocol; supersededNote: string }
  | { ok: false; duplicate: DuplicateMatch };

/** Build the provenance stamp, or undefined when the caller supplied none —
 *  an absent `source` is what the loader stamps as a plain custom protocol. */
function authorshipSource(input: AuthorProtocolInput): ProtocolSource | undefined {
  if (!input.authoredBy && !input.authoredFromSession) return undefined;
  return {
    type: "custom",
    ...(input.authoredBy ? { authoredBy: input.authoredBy, authoredAt: input.authoredAt ?? Date.now() } : {}),
    ...(input.authoredFromSession ? { authoredFromSession: input.authoredFromSession } : {}),
  };
}

/**
 * Create a protocol through the full authoring path: refuse near-duplicates
 * (unless the caller names what it supersedes), persist body + steps, stamp
 * provenance, and record the "built" event.
 *
 * `{ ok: false }` is a dedup refusal — an expected outcome, not an error.
 * Name collisions and write failures still throw.
 */
export async function authorProtocol(input: AuthorProtocolInput): Promise<AuthorProtocolResult> {
  const { name, description, supersedes } = input;
  const triggers = input.triggers || [];

  // Dedup — refuse near-duplicates unless the caller explicitly names what
  // it's replacing. Soft-degrades to a no-op when the embedding provider is
  // unavailable (memory init didn't run); dedup is a soft dependency and must
  // never block authoring.
  if (!supersedes) {
    const { findCatalogDuplicate } = await import("./dedup.js");
    const duplicate = await findCatalogDuplicate({ name, description, triggers });
    if (duplicate) return { ok: false, duplicate };
  }

  const source = authorshipSource(input);
  const protocol = createProtocol({
    name,
    description,
    triggers,
    steps: input.steps ?? [],
    rules: input.rules ?? [],
    learnablePreferences: [],
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(supersedes ? { supersedes } : {}),
    ...(source ? { source } : {}),
  });

  // If superseding, ARCHIVE the old protocol — never hard-delete it.
  //
  // `supersedes` is reachable from the ordinary agent path
  // (protocol(action:"create")), which is not in DESTRUCTIVE_TOOL_ACTIONS and
  // is blanket-allowed by the orchestration policy. A hard delete there meant
  // the model could irrecoverably erase a user-authored protocol with no
  // approval prompt and no undo. Archiving makes the operation recoverable,
  // which is the property that made the approval gate necessary in the first
  // place — so this is a fix at the primitive, not a policy-table change.
  //
  // Lazy import for the same reason builder.ts uses one: archive.js → builder.js
  // → authoring.js is a cycle at module-init time.
  let supersededNote = "";
  if (supersedes) {
    try {
      const { archiveProtocol } = await import("./archive.js");
      const record = archiveProtocol(supersedes, `superseded by "${name}"`);
      supersededNote = record
        ? ` Archived "${supersedes}" — restore with protocol(action:'unarchive').`
        : ` (Note: "${supersedes}" is not in the editable catalog, so nothing was replaced.)`;
    } catch (e) {
      supersededNote = ` (Failed to archive "${supersedes}": ${(e as Error).message})`;
    }
  }

  try {
    const { recordUsage } = await import("./usage.js");
    recordUsage({ action: "built", name: protocol.name, sessionId: input.sessionId });
  } catch { /* telemetry never fails the call */ }

  return { ok: true, protocol, supersededNote };
}
