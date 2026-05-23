import { join, resolve } from "node:path";

export const ROOT = resolve(join(import.meta.dirname || ".", "..", ".."));
export const CONFIG_DIR = join(ROOT, "config");
export const MANIFEST_PATH = join(CONFIG_DIR, "app-manifest.json");
