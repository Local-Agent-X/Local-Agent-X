/**
 * The files a Supabase deploy uploads, so its review reads those and not the whole
 * working tree.
 *
 * A deploy is reviewed as every unpushed commit plus every uncommitted change
 * (change-set.ts), because most deploys upload a directory. `supabase functions deploy
 * send-push-notification` uploads that one function, bundled with the local code it
 * imports; reviewing the tree put a week-old account-deletion migration and its
 * handoff notes in front of the reviewer, whose findings on them blocked every deploy
 * of a push fix that shipped neither (Scan Progress, 2026-11-26). `supabase db push`
 * applies the migrations folder.
 *
 * Never a smaller scope than the upload. Anything this cannot name for certain
 * returns null and the whole tree is reviewed as before: a function that is not
 * there, a custom entrypoint or static files in config.toml, an import map that
 * points at local files, a relative import that leaves the repository.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DeployUpload } from "../publish-operation-table.js";

type SupabaseUpload = Extract<DeployUpload, { tool: "supabase" }>;

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".json"]);
// Every module specifier a file names: `from "x"`, `import "x"`, `import("x")`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const CONFIG_NAMES = ["deno.json", "deno.jsonc", "import_map.json"];

async function exists(path: string): Promise<"file" | "dir" | null> {
  try { const s = await stat(path); return s.isDirectory() ? "dir" : s.isFile() ? "file" : null; } catch { return null; }
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** config.toml sets a function's files itself (a custom entrypoint, static files, its
 *  own import map): the upload is not the function folder, so it is not named here. */
function configNamesFiles(toml: string): boolean {
  return /^\s*(?:entrypoint|static_files|import_map)\s*=/m.test(toml);
}

/** An import map or deno.json that maps a specifier to a local path: a bare import can
 *  then reach any file, which a scan of relative imports would miss. */
function mapsToLocalPath(text: string): boolean {
  return /"imports"\s*:\s*\{[^}]*"\s*:\s*"(?:\.{0,2}\/|[A-Za-z]:[\\/])/s.test(text);
}

/**
 * The repository files a function folder's code reaches through relative imports, over
 * the files it starts from. null when an import leaves the repository.
 */
async function importClosure(start: string[], root: string): Promise<Set<string> | null> {
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (!CODE_EXT.has(extname(file))) continue;
    let text: string;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1];
      if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/")) continue;
      const target = spec.startsWith("/") ? resolve(spec) : resolve(dirname(file), spec);
      const rel = relative(root, target);
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
      if (seen.has(target)) continue;
      const kind = await exists(target);
      if (kind === "dir") return null; // a folder import resolves by rules this does not model
      if (kind === "file") { seen.add(target); queue.push(target); }
    }
  }
  return seen;
}

/** Repository-relative paths (forward slashes) the deploy uploads, or null when the
 *  whole working tree must be reviewed. */
export async function supabaseDeployPaths(cwd: string, repoRoot: string, upload: SupabaseUpload): Promise<string[] | null> {
  const supabaseDir = join(resolve(cwd, upload.workdir ?? "."), "supabase");
  if ((await exists(supabaseDir)) !== "dir") return null;
  const paths = new Set<string>();
  const config = join(supabaseDir, "config.toml");
  if ((await exists(config)) === "file") {
    paths.add(config);
    if (upload.what === "functions" && configNamesFiles(await readFile(config, "utf8"))) return null;
  }
  if (upload.what === "migrations") {
    paths.add(join(supabaseDir, "migrations"));
    return repoPaths(paths, repoRoot);
  }
  const functionsDir = join(supabaseDir, "functions");
  if ((await exists(functionsDir)) !== "dir") return null;
  const folders = upload.names.length > 0 ? upload.names.map((name) => join(functionsDir, name)) : [functionsDir];
  for (const configName of CONFIG_NAMES) {
    for (const dir of [functionsDir, ...folders]) {
      const file = join(dir, configName);
      if ((await exists(file)) !== "file") continue;
      if (mapsToLocalPath(await readFile(file, "utf8"))) return null;
      paths.add(file);
    }
  }
  const start: string[] = [];
  for (const folder of folders) {
    if ((await exists(folder)) !== "dir") return null;
    paths.add(folder);
    start.push(...(await filesUnder(folder)));
  }
  const reached = await importClosure(start, repoRoot);
  if (reached === null) return null;
  // A file under a named folder is already in its folder's path.
  for (const file of reached) if (!folders.some((f) => !relative(f, file).startsWith(".."))) paths.add(file);
  return repoPaths(paths, repoRoot);
}

function repoPaths(paths: Set<string>, repoRoot: string): string[] | null {
  const inRepo = [...paths].map((p) => relative(repoRoot, p).replace(/\\/g, "/"));
  return inRepo.some((p) => p === "" || p.startsWith("../") || isAbsolute(p)) ? null : inRepo.sort();
}
