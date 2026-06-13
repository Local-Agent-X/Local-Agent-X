import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Project root = two levels up from this module (src|dist / manifest-generator).
// import.meta.dirname is undefined under some loaders (notably tsx, which is
// the server's run-from-source fallback), so derive the module dir from
// import.meta.url instead, and only fall back to process.cwd() — the server's
// cwd IS the project root (config/ lives directly under it). The previous
// `import.meta.dirname || "."` fallback resolved to cwd/../.. = C:\Users,
// making every manifest write fail with ENOENT (C:\Users\config\app-manifest.json)
// whenever the server ran via tsx.
const moduleDir =
  import.meta.dirname ??
  (import.meta.url ? dirname(fileURLToPath(import.meta.url)) : undefined);

export const ROOT = moduleDir ? resolve(moduleDir, "..", "..") : process.cwd();
export const CONFIG_DIR = join(ROOT, "config");
export const MANIFEST_PATH = join(CONFIG_DIR, "app-manifest.json");
