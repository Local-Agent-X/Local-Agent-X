import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function probeLink(type: "file" | "dir" | "junction"): boolean {
  const root = mkdtempSync(join(tmpdir(), "lax-link-capability-"));
  const target = join(root, "target");
  const link = join(root, "link");
  try {
    if (type === "file") writeFileSync(target, "probe");
    else mkdirSync(target);
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const CAN_CREATE_FILE_SYMLINK = probeLink("file");
export const CAN_CREATE_DIRECTORY_SYMLINK = probeLink("dir");
export const CAN_CREATE_WINDOWS_JUNCTION = process.platform === "win32" && probeLink("junction");
export const CAN_CREATE_DIRECTORY_LINK = process.platform === "win32"
  ? CAN_CREATE_WINDOWS_JUNCTION
  : CAN_CREATE_DIRECTORY_SYMLINK;

