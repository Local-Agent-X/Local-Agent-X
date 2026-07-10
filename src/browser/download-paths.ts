import { existsSync, mkdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

function privateDownloadDir(name: "native" | "inspected", dataDir = getLaxDir()): string {
  const dir = resolve(dataDir, "browser-quarantine", name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getBrowserNativeDownloadDir(dataDir?: string): string {
  return privateDownloadDir("native", dataDir);
}

export function resetBrowserNativeDownloadDir(dataDir?: string): string {
  const dir = resolve(dataDir ?? getLaxDir(), "browser-quarantine", "native");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getBrowserInspectionDir(dataDir?: string): string {
  return privateDownloadDir("inspected", dataDir);
}

export function isInsideDirectory(path: string, directory: string): boolean {
  const rel = relative(resolve(directory), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !/^[a-z]:/i.test(rel));
}
