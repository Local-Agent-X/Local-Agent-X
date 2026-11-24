/**
 * The files a `firebase deploy --only <targets>` uploads, when every target is
 * one that uploads named files.
 *
 * A deploy is reviewed as the whole working tree (change-set.ts), because a
 * hosting or functions deploy uploads a directory. `--only remoteconfig`
 * uploads one JSON template, and `--only firestore:rules` one rules file, so
 * reviewing the tree put a project's every commit and file in front of the
 * reviewer, and its package-lock.json in front of the key scan, for a deploy
 * that sends neither (label-check, 2026-11-23).
 *
 * Each target's file is read from firebase.json in the directory the deploy
 * runs in, as the CLI reads it. firebase.json itself is in the scope: it says
 * which file goes. Anything this cannot name for certain (a hosting or
 * functions target, a target it does not know, a firebase.json it cannot read
 * or that names no file for the target) returns null, and the whole tree is
 * reviewed as before. Never a smaller scope than the upload.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

type Config = Record<string, unknown>;

/** A firebase.json product section: one object, or a list of them (one per
 *  database, bucket or instance). */
function sections(value: unknown): Config[] | null {
  const list = Array.isArray(value) ? value : [value];
  return list.every((s) => s !== null && typeof s === "object" && !Array.isArray(s)) ? (list as Config[]) : null;
}

/** The `keys` of every section of `product`, or null if one is missing. */
function filesOf(config: Config, product: string, keys: string[]): string[] | null {
  const list = sections(config[product]);
  if (!list || list.length === 0) return null;
  const files: string[] = [];
  for (const section of list) {
    for (const key of keys) {
      const file = section[key];
      if (typeof file !== "string" || !file) return null;
      files.push(file);
    }
  }
  return files;
}

/** The files one `--only` target uploads, or null. `storage:main` and
 *  `database:instance` deploy one of several; all of them are named. */
function targetFiles(config: Config, target: string): string[] | null {
  const [product, part] = target.split(":", 2);
  switch (product) {
    case "remoteconfig": return part ? null : filesOf(config, "remoteconfig", ["template"]);
    case "storage": return filesOf(config, "storage", ["rules"]);
    case "database": return filesOf(config, "database", ["rules"]);
    case "firestore":
      if (part === "rules") return filesOf(config, "firestore", ["rules"]);
      if (part === "indexes") return filesOf(config, "firestore", ["indexes"]);
      return part ? null : filesOf(config, "firestore", ["rules", "indexes"]);
    default: return null;
  }
}

/**
 * Repository-relative paths (forward slashes) of every file `targets` upload,
 * plus firebase.json; null when the whole working tree must be reviewed.
 */
export async function firebaseDeployPaths(cwd: string, repoRoot: string, targets: readonly string[]): Promise<string[] | null> {
  let config: Config;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, "firebase.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    config = parsed as Config;
  } catch {
    return null; // no firebase.json here, or not JSON: the CLI's own error, and the whole tree is reviewed
  }
  const paths = new Set([join(cwd, "firebase.json")]);
  for (const target of targets) {
    const files = targetFiles(config, target);
    if (!files) return null;
    for (const file of files) paths.add(resolve(cwd, file));
  }
  const inRepo = [...paths].map((p) => relative(repoRoot, p).replace(/\\/g, "/"));
  // A file outside the repository (or on another drive) has no diff to review it by.
  return inRepo.some((p) => p.startsWith("../") || isAbsolute(p)) ? null : inRepo;
}
