/**
 * Canonical JSON-file persistence. Every small on-disk JSON store (persona
 * modules, trackers, caches under ~/.lax) routes through here.
 *
 * Contract (extracted from the 15 near-identical private copies this
 * replaces — emotional-memory, trust-deepening, growth-tracker-store, the
 * associative-recall/anticipatory-care/proactive persistence files, etc.):
 *   - atomic write: random-suffixed tmp file + rename; tmp unlinked
 *     best-effort on throw, error rethrown (never swallowed)
 *   - load: missing file → defaults; corrupt JSON → defaults; parsed keys
 *     merged over defaults with per-key shape validation
 *   - save: parent dir ensured; per-key array caps applied IN PLACE (so the
 *     caller's in-memory object stays in sync, matching the old copies)
 *
 * Everything is synchronous — all existing callers are sync. Callers pass an
 * explicit absolute filePath (usually getLaxDir()-derived) so tests can point
 * a store at a mkdtemp dir and never touch ~/.lax.
 *
 * Do NOT hand-roll atomicWrite/loadStore/saveStore elsewhere; extend this.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/**
 * Atomic file write: write to a random-suffixed `<path>.tmp.<hex>` then
 * rename over the target. On POSIX, rename within one filesystem is atomic,
 * so a concurrent reader never sees a half-written file. On failure the tmp
 * file is unlinked best-effort and the underlying error is rethrown so
 * callers can log meaningfully.
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string,
  opts?: { mode?: number; encoding?: BufferEncoding },
): void {
  const tmp = filePath + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmp, data, { encoding: opts?.encoding ?? "utf-8", mode: opts?.mode });
    renameSync(tmp, filePath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

/** mkdir -p the parent directory of `filePath`. */
export function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Array cap applied at save time.
 *   - bare number → keep the LAST n entries (`slice(-n)`, the common
 *     append-log pattern)
 *   - `{ max, keep: "head" }` → keep the FIRST n (`slice(0, n)`), for stores
 *     that sort best-first before saving (growth-tracker, inside-references)
 */
export type CapSpec = number | { max: number; keep: "head" | "tail" };

export interface JsonStoreOptions<T extends Record<string, unknown>> {
  /** Factory (not a shared value) so each load starts from a fresh object. */
  defaults: () => T;
  /** Per-key array caps applied in place on save. */
  caps?: { [K in keyof T]?: CapSpec };
  /**
   * Optional legacy-shape adapter run on the parsed JSON before the merge
   * (e.g. emotional-memory's pre-envelope bare-array files). Return the
   * value reshaped to the current schema; shape validation still applies.
   */
  upgrade?: (parsed: unknown) => unknown;
}

export interface JsonStore<T extends Record<string, unknown>> {
  /** Read + validate the file; defaults on missing or corrupt. */
  load(): T;
  /** Ensure dir, apply caps in place, atomically write pretty JSON. */
  save(value: T): void;
  /** load → fn(draft) → save. Returns fn's result. */
  mutate<R>(fn: (draft: T) => R): R;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge parsed JSON over defaults, key by key, keeping a parsed value only
 * when its shape matches the default's (array↔array, object↔object,
 * matching primitive typeof; a null default accepts anything non-nullish).
 * Unknown keys are dropped. This generalizes the per-field
 * `Array.isArray(parsed.x) ? parsed.x : []` / `parsed.y ?? fallback`
 * validation every copy hand-rolled.
 */
function mergeWithDefaults<T extends Record<string, unknown>>(base: T, parsed: unknown): T {
  if (!isPlainObject(parsed)) return base;
  for (const key of Object.keys(base) as Array<keyof T>) {
    const def = base[key];
    const val = (parsed as Record<string, unknown>)[key as string];
    if (Array.isArray(def)) {
      if (Array.isArray(val)) base[key] = val as T[typeof key];
    } else if (def === null) {
      base[key] = (val ?? null) as T[typeof key];
    } else if (isPlainObject(def)) {
      if (isPlainObject(val)) base[key] = val as T[typeof key];
    } else if (typeof val === typeof def) {
      base[key] = val as T[typeof key];
    }
  }
  return base;
}

function applyCaps<T extends Record<string, unknown>>(
  value: T,
  caps: JsonStoreOptions<T>["caps"],
): void {
  if (!caps) return;
  for (const key of Object.keys(caps) as Array<keyof T>) {
    const spec = caps[key];
    if (spec === undefined) continue;
    const arr = value[key];
    if (!Array.isArray(arr)) continue;
    const max = typeof spec === "number" ? spec : spec.max;
    const keep = typeof spec === "number" ? "tail" : spec.keep;
    if (arr.length <= max) continue;
    value[key] = (keep === "head" ? arr.slice(0, max) : arr.slice(-max)) as T[typeof key];
  }
}

export function createJsonStore<T extends Record<string, unknown>>(
  filePath: string,
  options: JsonStoreOptions<T>,
): JsonStore<T> {
  const { defaults, caps, upgrade } = options;

  function load(): T {
    if (!existsSync(filePath)) return defaults();
    try {
      const raw = readFileSync(filePath, "utf-8");
      let parsed: unknown = JSON.parse(raw);
      if (upgrade) parsed = upgrade(parsed);
      return mergeWithDefaults(defaults(), parsed);
    } catch {
      return defaults();
    }
  }

  function save(value: T): void {
    ensureDirFor(filePath);
    applyCaps(value, caps);
    atomicWriteFileSync(filePath, JSON.stringify(value, null, 2));
  }

  function mutate<R>(fn: (draft: T) => R): R {
    const draft = load();
    const result = fn(draft);
    save(draft);
    return result;
  }

  return { load, save, mutate };
}
