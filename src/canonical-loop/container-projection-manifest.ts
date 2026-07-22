import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  computeDurableRecordMac,
  verifyDurableRecordMac,
} from "../app-runtime/audit-signing.js";
import { isContainerConnectivityIdentity,
  type ContainerConnectivityIdentity } from "./container-connectivity.js";

const PROJECTION_DOMAIN = "canonical-container-projection-v1";

export interface ProjectionManifest {
  schemaVersion: 1;
  projectionId: string;
  opId: string;
  descriptorMac: string;
  connectivity: ContainerConnectivityIdentity;
  files: Record<string, string>;
  mounts: Record<string, { device: string; inode: string }>;
}

interface SealedProjectionManifest { manifest: ProjectionManifest; mac: string }

export function sealManifest(manifest: ProjectionManifest): SealedProjectionManifest {
  return { manifest, mac: computeDurableRecordMac(PROJECTION_DOMAIN, JSON.stringify(manifest)) };
}

export function readManifest(root: string): ProjectionManifest {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("container projection root is invalid");
  }
  const path = join(root, "projection.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error("container projection manifest is invalid");
  }
  const sealed = JSON.parse(readFileSync(path, "utf8")) as Partial<SealedProjectionManifest>;
  const manifest = sealed.manifest as Partial<ProjectionManifest> | undefined;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.projectionId !== basename(root)
    || !manifest.opId || typeof manifest.descriptorMac !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.descriptorMac)
    || !isContainerConnectivityIdentity(manifest.connectivity)
    || !manifest.files || typeof manifest.files !== "object" || !manifest.mounts
    || typeof manifest.mounts !== "object"
    || Object.entries(manifest.files).some(([file, hash]) => !/^(?:state|secrets)\/[A-Za-z0-9._-]+$/.test(file)
      || !/^[a-f0-9]{64}$/.test(hash))
    || Object.entries(manifest.mounts).some(([name, identity]) => !/^[A-Za-z]+$/.test(name)
      || !identity || !/^\d+$/.test(identity.device) || !/^\d+$/.test(identity.inode))
    || !["state", "operation", "workspace", "credential", "audit", "bootstrap",
      "browserRelayToken"]
      .every(name => name in (manifest.mounts ?? {}))
    || typeof sealed.mac !== "string"
    || !verifyDurableRecordMac(PROJECTION_DOMAIN, JSON.stringify(manifest), sealed.mac)) {
    throw new Error("container projection manifest integrity check failed");
  }
  return manifest as ProjectionManifest;
}

export function verifyManifestFiles(root: string, manifest: ProjectionManifest): void {
  for (const [file, hash] of Object.entries(manifest.files)) {
    const path = join(root, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || hashFile(path) !== hash) {
      throw new Error("container projection file integrity check failed");
    }
  }
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function fileIdentity(path: string): { device: string; inode: string } {
  const stat = lstatSync(path, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}
