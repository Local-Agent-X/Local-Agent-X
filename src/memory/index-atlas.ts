import type Database from "better-sqlite3";

// Lightweight per-chunk records for the memory brain visual. One row per dot:
// just enough to render and read on hover (id + a short snippet + provenance),
// never the embedding vector. Projection coordinates are added in a later phase.

export interface AtlasRecord {
  id: number;
  snippet: string;
  source: string;
  date: string | null;
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
    let date: string | null = null;
    if (r.metadata) {
      try {
        date = (JSON.parse(r.metadata) as { date?: string }).date ?? null;
      } catch {
        // malformed metadata blob — leave date null
      }
    }
    const snippet = (r.snippet || "").replace(/\s+/g, " ").trim().slice(0, 140);
    return { id: r.id, snippet, source: r.source, date };
  });

  return { total, items };
}

export interface AtlasChunk {
  id: number;
  text: string;
  source: string;
  date: string | null;
  path: string;
}

// Full text + provenance for one chunk — backs the inspector's expand-on-click.
export function getChunk(db: InstanceType<typeof Database>, id: number): AtlasChunk | null {
  const r = db
    .prepare("SELECT id, text, source, metadata, path FROM chunks WHERE id = ?")
    .get(id) as { id: number; text: string; source: string; metadata: string | null; path: string } | undefined;
  if (!r) return null;
  let date: string | null = null;
  if (r.metadata) {
    try {
      date = (JSON.parse(r.metadata) as { date?: string }).date ?? null;
    } catch {
      // malformed metadata blob — leave date null
    }
  }
  return { id: r.id, text: r.text, source: r.source, date, path: r.path };
}
