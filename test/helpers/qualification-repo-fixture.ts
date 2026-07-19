import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type WorkspaceLayout = "absent" | "empty" | "populated" | "junction";

function tree(path: string): unknown {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      return {
        kind: "link",
        target,
        mtimeNs: stat.mtimeNs.toString(),
        targetState: tree(resolve(dirname(path), target)),
      };
    }
    if (stat.isDirectory()) {
      return {
        kind: "directory",
        mtimeNs: stat.mtimeNs.toString(),
        entries: readdirSync(path).sort().map((name) => [name, tree(join(path, name))]),
      };
    }
    return {
      kind: "file",
      mtimeNs: stat.mtimeNs.toString(),
      bytes: readFileSync(path).toString("base64"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

export interface QualificationRepoFixture {
  root: string;
  snapshot(): unknown;
  cleanup(): void;
}

export function createQualificationRepoFixture(
  realRepo: string,
  layout: WorkspaceLayout,
  dependencyRoot = realRepo,
): QualificationRepoFixture {
  const root = mkdtempSync(join(tmpdir(), "lax-qualification-product-repo-"));
  const linked = ["src", "packages", "public", "config"];
  for (const name of linked) linkDirectory(join(realRepo, name), join(root, name));
  linkDirectory(join(dependencyRoot, "node_modules"), join(root, "node_modules"));
  const workspace = join(root, "workspace");
  if (layout === "empty") mkdirSync(workspace);
  if (layout === "populated") {
    mkdirSync(join(workspace, "nested"), { recursive: true });
    writeFileSync(join(workspace, "nested", "user.txt"), "preserve-exactly", "utf8");
  }
  if (layout === "junction") {
    const target = join(root, "workspace-target");
    mkdirSync(join(target, "nested"), { recursive: true });
    writeFileSync(join(target, "nested", "user.txt"), "preserve-exactly", "utf8");
    linkDirectory(target, workspace);
  }
  return {
    root,
    snapshot: () => ({
      workspace: tree(workspace),
      manifest: tree(join(root, "config", "app-manifest.json")),
    }),
    cleanup: () => {
      for (const name of ["workspace", ...linked, "node_modules"]) {
        const path = join(root, name);
        try {
          if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
