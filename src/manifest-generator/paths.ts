import { join } from "node:path";
import { platformRoot } from "../platform-root.js";

// The manifest lives under the install's own config/ — platform-root.ts owns
// where that is, under every loader (a local module-dir fallback once
// resolved to cwd/../.. = C:\Users under tsx and every write failed).
export const ROOT = platformRoot();
export const CONFIG_DIR = join(ROOT, "config");
export const MANIFEST_PATH = join(CONFIG_DIR, "app-manifest.json");
