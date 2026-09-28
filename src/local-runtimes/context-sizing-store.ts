/**
 * Persisted context-sizing decisions, one per (runtime root, model), in the
 * LAX data dir. A decision is reused only while its fingerprint — model
 * digest, runtime version, GPU name + VRAM, the background models it left
 * room for, KV cache type — still matches; any change re-decides. The
 * verification outcome rides on the record, so a size that spilled once is
 * never tried again on the same hardware. Same write discipline as
 * certification-store.ts: bounded, atomic rename, a bad file reads as empty.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getLaxDir } from "../lax-data-dir.js";

const MAX_ENTRIES = 64;
const MAX_STORE_BYTES = 128 * 1024;
const nullableInt = z.number().int().nonnegative().nullable();

export const SizingRecordSchema = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  numCtx: z.number().int().positive().nullable(),
  reason: z.enum([
    "fits_gpu", "native_max_fits", "remote_runtime", "gpu_unknown", "model_info_incomplete",
    "native_below_floor", "gpu_too_small", "spilled_at_floor",
  ]),
  nativeMax: nullableInt,
  weightsBytes: nullableInt,
  kvBytesPerToken: nullableInt,
  headroomBytes: z.number().int().nonnegative(),
  budgetBytes: z.number().int().nullable(),
  estimatedBytes: nullableInt,
  gpu: z.object({
    name: z.string(),
    totalBytes: z.number().int().positive(),
    source: z.enum(["measured", "estimated"]),
  }).strict().nullable(),
  verification: z.enum(["pending", "verified", "stepped_down"]),
  decidedAt: z.string(),
  verifiedAt: z.string().optional(),
}).strict();

export type SizingRecord = z.infer<typeof SizingRecordSchema>;

export class ContextSizingStore {
  constructor(private readonly file = join(getLaxDir(), "local-context-sizing.json")) {}

  read(key: string): SizingRecord | null {
    return this.readAll()[key] ?? null;
  }

  write(record: SizingRecord): void {
    const clean = SizingRecordSchema.safeParse(record);
    if (!clean.success) return;
    const existing = this.readAll();
    delete existing[record.key];
    // Oldest decisions go first when the file is full.
    const kept = Object.values(existing)
      .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1))
      .slice(0, MAX_ENTRIES - 1);
    const entries: Record<string, SizingRecord> = { [record.key]: clean.data };
    for (const r of kept) entries[r.key] = r;
    let contents = JSON.stringify({ version: 1, entries }, null, 2);
    while (Buffer.byteLength(contents, "utf8") > MAX_STORE_BYTES && kept.length > 0) {
      delete entries[kept.pop()!.key];
      contents = JSON.stringify({ version: 1, entries }, null, 2);
    }
    const tmp = `${this.file}.tmp.${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  private readAll(): Record<string, SizingRecord> {
    if (!existsSync(this.file)) return {};
    try {
      if (statSync(this.file).size > MAX_STORE_BYTES) return {};
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; entries?: unknown };
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return {};
      const out: Record<string, SizingRecord> = {};
      for (const [key, value] of Object.entries(parsed.entries).slice(0, MAX_ENTRIES)) {
        const r = SizingRecordSchema.safeParse(value);
        if (r.success && r.data.key === key) out[key] = r.data;
      }
      return out;
    } catch {
      return {}; // unreadable store = no decisions on file; the next decide rewrites it
    }
  }
}
