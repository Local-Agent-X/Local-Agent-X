import type Database from "better-sqlite3";
import { describeChunkProvenance } from "./search-helpers.js";
import type { CanonicalSource, ChunkMetadata, MemoryTaintStatus, MemoryTrustStatus } from "./types.js";

// Lightweight per-chunk records for the memory brain visual. One row per dot:
// just enough to render and read on hover (id + a short snippet + provenance),
// never the embedding vector. Projection coordinates are added in a later phase.

export interface AtlasRecord {
  id: number;
  snippet: string;
  source: string;
  sourceType: string;
  date: string | null;
  sessionId: string | null;
  trustStatus: MemoryTrustStatus;
  taintStatus: MemoryTaintStatus;
  label: string;
}

export interface AtlasResult {
  total: number;
  items: AtlasRecord[];
}

// Signature that changes whenever the embedded-chunk set changes — drives
// atlas layout cache invalidation.
export function getAtlasSignature(db: InstanceType<typeof Database>): string {
  const r = db
    .prepare("SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM chunks WHERE embedding IS NOT NULL")
    .get() as { c: number; m: number | null };
  return `${r.c}:${r.m ?? 0}`;
}

export function getAtlasRecords(
  db: InstanceType<typeof Database>,
  limit: number,
): AtlasResult {
  // Only embedded chunks get a layout position, so the snippet set must match.
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL").get() as { c: number }
  ).c;
  // Truncate in SQL — reading the full text column for every chunk just to
  // slice it client-side means hauling ~60MB off disk for a 140-char preview.
  // substr keeps the read tiny. 200 leaves room for whitespace collapse below.
  const rows = db
    .prepare("SELECT id, substr(text, 1, 200) AS snippet, source, metadata FROM chunks WHERE embedding IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Array<{ id: number; snippet: string; source: string; metadata: string | null }>;

  const items = rows.map((r) => {
    let metadata: ChunkMetadata | undefined;
    if (r.metadata) {
      try {
        metadata = JSON.parse(r.metadata) as ChunkMetadata;
      } catch {
        // malformed metadata blob — derive legacy provenance from source
      }
    }
    const provenance = describeChunkProvenance(r.source as CanonicalSource, metadata);
    const snippet = (r.snippet || "").replace(/\s+/g, " ").trim().slice(0, 140);
    return {
      id: r.id, snippet, source: r.source, sourceType: provenance.source_type,
      date: provenance.date ?? null, sessionId: provenance.session_id ?? null,
      trustStatus: provenance.trust_status, taintStatus: provenance.taint_status,
      label: provenance.label,
    };
  });

  return { total, items };
}

export interface AtlasChunk {
  id: number;
  text: string;
  source: string;
  sourceType: string;
  date: string | null;
  sessionId: string | null;
  trustStatus: MemoryTrustStatus;
  taintStatus: MemoryTaintStatus;
  label: string;
  path: string;
}

// Full text + provenance for one chunk — backs the inspector's expand-on-click.
export function getChunk(db: InstanceType<typeof Database>, id: number): AtlasChunk | null {
  const r = db
    .prepare("SELECT id, text, source, metadata, path FROM chunks WHERE id = ?")
    .get(id) as { id: number; text: string; source: string; metadata: string | null; path: string } | undefined;
  if (!r) return null;
  let metadata: ChunkMetadata | undefined;
  if (r.metadata) {
    try {
      metadata = JSON.parse(r.metadata) as ChunkMetadata;
    } catch {
      // malformed metadata blob — derive legacy provenance from source
    }
  }
  const provenance = describeChunkProvenance(r.source as CanonicalSource, metadata);
  return {
    id: r.id, text: r.text, source: r.source, sourceType: provenance.source_type,
    date: provenance.date ?? null, sessionId: provenance.session_id ?? null,
    trustStatus: provenance.trust_status, taintStatus: provenance.taint_status,
    label: provenance.label, path: r.path,
  };
}
