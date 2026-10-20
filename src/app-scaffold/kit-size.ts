/**
 * The size rule, for code in this process that must apply it: the kit's own
 * counter (kit/code-size.mjs) and its caps, typed. The rule lives once, in the
 * kit; a built project runs it as a script, and a caller here (the autopilot's
 * round gate, the build prompts) asks this module instead of counting itself.
 *
 * Owns: loading the vendored counter and naming what is over a cap. Does not
 * own: the counting (the kit), the caps a repo chooses for itself (its check's
 * flags), or what a gate does with an item over (its caller).
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A file or function's caps and warning thresholds, in code lines (comments are free). */
export interface KitSizeLimits { maxCode: number; warnCode: number; maxFn: number; warnFn: number }

interface SizeItem { key: string; kind: "file" | "function"; size: number; line: number }
interface Measured { code: number; functions: Array<{ name: string; line: number; code: number }> | null; approximate: boolean }

const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "kit");
const kitModule = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(KIT_DIR, name)).href)) as T;

const codeSize = await kitModule<{
  DEFAULT_LIMITS: KitSizeLimits;
  measureSource(file: string, text: string, repo?: string): Measured;
  sizeItems(rel: string, measured: Measured): SizeItem[];
  bandOf(item: SizeItem, limits: KitSizeLimits): "over" | "near" | "ok";
  capOf(item: SizeItem, limits: KitSizeLimits): number;
  unitOf(item: SizeItem): string;
}>("code-size.mjs");
const { isSourceFile } = await kitModule<{ isSourceFile(name: string): boolean }>("project-languages.mjs");

/** The /new-project caps every built project starts with. */
export const KIT_LIMITS: KitSizeLimits = codeSize.DEFAULT_LIMITS;

/** The same caps under the names the prompts and docs use. */
export const KIT_SIZE_CAPS = {
  file: KIT_LIMITS.maxCode, fileWarn: KIT_LIMITS.warnCode, fn: KIT_LIMITS.maxFn, fnWarn: KIT_LIMITS.warnFn,
} as const;

export interface OverCap { key: string; size: number; cap: number; unit: string }

/**
 * The parts of one source file over its caps: the file itself and each function
 * the kit measures. `file` is the path on disk (its extension picks the
 * language), `rel` the name the items carry, `text` the content to measure (a
 * caller comparing two versions passes each), `repo` where a TypeScript is
 * looked up. A file the kit does not treat as source has no parts.
 */
export function overCapItems(file: string, rel: string, text: string, repo: string, limits: KitSizeLimits = KIT_LIMITS): OverCap[] {
  if (!isSourceFile(file)) return [];
  return codeSize.sizeItems(rel, codeSize.measureSource(file, text, repo))
    .filter((item) => codeSize.bandOf(item, limits) === "over")
    .map((item) => ({ key: item.key, size: item.size, cap: codeSize.capOf(item, limits), unit: codeSize.unitOf(item) }));
}
