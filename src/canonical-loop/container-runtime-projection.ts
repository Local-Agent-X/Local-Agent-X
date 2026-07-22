import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  computeDurableRecordMac,
  getAuditHmacKey,
  verifyDurableRecordMac,
} from "../app-runtime/audit-signing.js";
import { resolveCredential } from "../auth/resolve.js";
import { getRuntimeConfig, workspaceRoot } from "../config.js";
import { getLaxDir } from "../lax-data-dir.js";
import { opDir } from "../ops/event-log.js";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { getLocalRuntimeById } from "../local-runtimes/index.js";
import { verifyDelegatedRuntimeIntegrity } from "./runtime-integrity.js";
import { settingsPath } from "../settings.js";
import {
  DockerCliExecutionRuntime,
  type DockerContainerSpec,
  type DockerExecutionRuntime,
} from "../sandbox/docker-execution-runtime.js";
import type { ContainerLaunchProjection } from "./container-execution-backend.js";
import { sealContainerBootstrap } from "./container-bootstrap.js";

const CONTAINER_DATA = "/var/lib/lax";
const CONTAINER_SECRETS = "/run/lax-secrets";
const WORKER_ENTRY = "/opt/lax/dist/canonical-loop/container-worker-entry.js";
const PROJECTION_DOMAIN = "canonical-container-projection-v1";
const CREDENTIAL_DOMAIN = "canonical-container-credential-v1";

interface ProjectionManifest {
  schemaVersion: 1;
  projectionId: string;
  opId: string;
  descriptorMac: string;
  files: Record<string, string>;
  mounts: Record<string, { device: string; inode: string }>;
}

interface SealedProjectionManifest { manifest: ProjectionManifest; mac: string }

export function createProductionContainerRuntime(): DockerExecutionRuntime {
  let delegate: DockerExecutionRuntime | null = null;
  const runtime = (): DockerExecutionRuntime => {
    delegate ??= new DockerCliExecutionRuntime(undefined, {
      approvedMountRoots: productionMountRoots(),
      allowedNetwork: configuredNetwork(),
    });
    return delegate;
  };
  return {
    probe: () => runtime().probe(),
    resolvePinnedImage: reference => runtime().resolvePinnedImage(reference),
    create: spec => runtime().create(spec),
    start: id => runtime().start(id),
    inspect: id => runtime().inspect(id),
    inspectNamed: (name, labels) => runtime().inspectNamed(name, labels),
    wait: id => runtime().wait(id),
    stop: id => runtime().stop(id),
  };
}

export async function createContainerRuntimeProjection(op: Op): Promise<ContainerLaunchProjection> {
  verifyDelegatedRuntimeIntegrity(op);
  const descriptor = op.runtimeDescriptor;
  assertProjectionPaths(descriptor);
  const projectionId = randomUUID();
  const root = join(containerStateRoot(), projectionId);
  const state = join(root, "state");
  const secrets = join(root, "secrets");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(secrets, { mode: 0o700 });
  try {
    writeJson(join(state, "config.json"), projectedConfig());
    copyOptionalJson(settingsPath(), join(state, "settings.json"));
    copyOptionalJson(join(getLaxDir(), "tool-policy.json"), join(state, "tool-policy.json"));

    const credential = await resolveCredential(descriptor.credentialProvider, {
      requiredSource: descriptor.authSource,
      configOpenAIKey: descriptor.credentialProvider === "openai"
        ? getRuntimeConfig().openaiApiKey : undefined,
    });
    if (!credential) throw new Error("container execution credential is unavailable");
    const credentialPath = join(secrets, "runtime-credential.json");
    writeJson(credentialPath, {
      credential,
      mac: computeDurableRecordMac(CREDENTIAL_DOMAIN, JSON.stringify(credential)),
    });
  const auditPath = join(secrets, "audit-key");
  const key = getAuditHmacKey();
  writeJson(auditPath, { schemaVersion: 1, key: Buffer.from(key).toString("base64") });
    const bootstrapPath = join(secrets, "bootstrap.json");
    writeJson(bootstrapPath, { schemaVersion: 1, state: "pending" });
    const localRuntimePath = projectLocalRuntime(descriptor, secrets);
    const tracked = ["state/config.json", "state/settings.json", "state/tool-policy.json",
      "secrets/runtime-credential.json", "secrets/audit-key", "secrets/local-runtime.json"]
      .filter(path => existsSync(join(root, path)));
    const manifest: ProjectionManifest = { schemaVersion: 1, projectionId, opId: op.id,
      descriptorMac: descriptor.integrity.mac,
      files: Object.fromEntries(tracked.map(path => [path, hashFile(join(root, path))])),
      mounts: Object.fromEntries([
        ["state", state], ["operation", opDir(op.id)], ["workspace", realpathSync(workspaceRoot())],
        ["credential", credentialPath], ["audit", auditPath], ["bootstrap", bootstrapPath],
        ...(localRuntimePath ? [["localRuntime", localRuntimePath]] : []),
      ].map(([name, path]) => [name, fileIdentity(path)])),
    };
    writeJson(join(root, "projection.json"), sealManifest(manifest));
    return materializeProjection(op, projectionId, root, localRuntimePath !== null);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function reopenContainerRuntimeProjection(
  op: Op,
  projectionId: string,
): Promise<ContainerLaunchProjection> {
  verifyDelegatedRuntimeIntegrity(op);
  const root = projectionRoot(projectionId);
  const manifest = readManifest(root);
  if (manifest.opId !== op.id || manifest.descriptorMac !== op.runtimeDescriptor.integrity.mac) {
    throw new Error("container projection identity changed");
  }
  verifyManifestFiles(root, manifest);
  return materializeProjection(op, projectionId, root, "secrets/local-runtime.json" in manifest.files);
}

function materializeProjection(
  op: Op,
  projectionId: string,
  root: string,
  hasLocalRuntime: boolean,
): ContainerLaunchProjection {
  const state = join(root, "state");
  const secrets = join(root, "secrets");
  const credentialPath = join(secrets, "runtime-credential.json");
  const auditPath = join(secrets, "audit-key");
  const bootstrapPath = join(secrets, "bootstrap.json");
  const localRuntimePath = hasLocalRuntime ? join(secrets, "local-runtime.json") : null;
  const workspace = realpathSync(workspaceRoot());
  const operation = opDir(op.id);
  return {
    durableId: projectionId,
    buildSpec({ image, placement }): DockerContainerSpec {
      verifyDelegatedRuntimeIntegrity(op);
      const manifest = readManifest(root);
      if (manifest.opId !== op.id || manifest.descriptorMac !== op.runtimeDescriptor.integrity.mac) {
        throw new Error("container projection identity changed");
      }
      verifyManifestFiles(root, manifest);
      const network = configuredNetwork();
      return {
        name: `lax-op-${op.id.slice(0, 48)}-${randomBytes(4).toString("hex")}`,
        image,
        command: ["node", WORKER_ENTRY],
        environment: {
          LAX_DATA_DIR: CONTAINER_DATA,
          LAX_CONTAINER_BOOTSTRAP: `${CONTAINER_SECRETS}/bootstrap.json`,
          LAX_SCOPED_RUNTIME_CREDENTIAL_FILE: `${CONTAINER_SECRETS}/runtime-credential.json`,
          LAX_AUDIT_KEY_FILE: `${CONTAINER_SECRETS}/audit-key`,
          ...(process.env.LAX_CONTAINER_HOST_GATEWAY
            ? { LAX_CONTAINER_HOST_GATEWAY: process.env.LAX_CONTAINER_HOST_GATEWAY }
            : {}),
          ...(localRuntimePath
            ? { LAX_PROJECTED_LOCAL_RUNTIME_FILE: `${CONTAINER_SECRETS}/local-runtime.json` }
            : {}),
        },
        mounts: [
          { source: state, target: CONTAINER_DATA, readOnly: false, identity: manifest.mounts.state },
          { source: operation, target: `${CONTAINER_DATA}/operations/${op.id}`, readOnly: false,
            identity: manifest.mounts.operation },
          { source: workspace, target: workspace, readOnly: false, identity: manifest.mounts.workspace },
          { source: credentialPath, target: `${CONTAINER_SECRETS}/runtime-credential.json`, readOnly: true,
            identity: manifest.mounts.credential },
          { source: auditPath, target: `${CONTAINER_SECRETS}/audit-key`, readOnly: true,
            identity: manifest.mounts.audit },
          { source: bootstrapPath, target: `${CONTAINER_SECRETS}/bootstrap.json`, readOnly: true,
            identity: manifest.mounts.bootstrap },
          ...(localRuntimePath ? [{
            source: localRuntimePath,
            target: `${CONTAINER_SECRETS}/local-runtime.json`,
            readOnly: true,
            identity: manifest.mounts.localRuntime,
          }] : []),
        ],
        network: network ? { name: network.name } : "none",
        user: containerUser(),
        memoryLimit: process.env.LAX_CONTAINER_EXECUTION_MEMORY ?? "4g",
        pidsLimit: 256,
        labels: {
          "lax.execution.backend": placement.backendId,
          "lax.execution.op": op.id,
          "lax.execution.revision": String(placement.revision),
          "lax.execution.target": placement.targetId,
        },
      };
    },
    writeBootstrap({ token, placement, container }): void {
      writeJson(bootstrapPath, sealContainerBootstrap({
        schemaVersion: 1,
        opId: op.id,
        backendId: placement.backendId,
        targetId: placement.targetId,
        placementRevision: placement.revision,
        token,
        containerId: container.containerId,
        containerCreatedAt: container.createdAt,
        imageDigest: container.imageId,
      }));
    },
    cleanup(): void {
      readManifest(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function productionMountRoots(): string[] {
  mkdirSync(containerStateRoot(), { recursive: true, mode: 0o700 });
  mkdirSync(join(getLaxDir(), "operations"), { recursive: true, mode: 0o700 });
  return [containerStateRoot(), join(getLaxDir(), "operations"), workspaceRoot()];
}

function containerStateRoot(): string {
  return join(getLaxDir(), "container-runtime");
}

function projectionRoot(projectionId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(projectionId)) {
    throw new Error("invalid container projection identity");
  }
  return join(containerStateRoot(), projectionId);
}

function sealManifest(manifest: ProjectionManifest): SealedProjectionManifest {
  return { manifest, mac: computeDurableRecordMac(PROJECTION_DOMAIN, JSON.stringify(manifest)) };
}

function readManifest(root: string): ProjectionManifest {
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
    || !manifest.files || typeof manifest.files !== "object" || !manifest.mounts
    || typeof manifest.mounts !== "object"
    || Object.entries(manifest.files).some(([file, hash]) => !/^(?:state|secrets)\/[A-Za-z0-9._-]+$/.test(file)
      || !/^[a-f0-9]{64}$/.test(hash))
    || Object.entries(manifest.mounts).some(([name, identity]) => !/^[A-Za-z]+$/.test(name)
      || !identity || !/^\d+$/.test(identity.device) || !/^\d+$/.test(identity.inode))
    || !["state", "operation", "workspace", "credential", "audit", "bootstrap"]
      .every(name => name in (manifest.mounts ?? {}))
    || typeof sealed.mac !== "string"
    || !verifyDurableRecordMac(PROJECTION_DOMAIN, JSON.stringify(manifest), sealed.mac)) {
    throw new Error("container projection manifest integrity check failed");
  }
  return manifest as ProjectionManifest;
}

function verifyManifestFiles(root: string, manifest: ProjectionManifest): void {
  for (const [file, hash] of Object.entries(manifest.files)) {
    const path = join(root, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || hashFile(path) !== hash) {
      throw new Error("container projection file integrity check failed");
    }
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileIdentity(path: string): { device: string; inode: string } {
  const stat = lstatSync(path, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function configuredNetwork(): { name: string; id: string } | null {
  const name = process.env.LAX_CONTAINER_EXECUTION_NETWORK?.trim();
  const id = process.env.LAX_CONTAINER_EXECUTION_NETWORK_ID?.trim();
  if (!name && !id) return null;
  if (!name || !id || !/^[a-f0-9]{64}$/.test(id)) {
    throw new Error("container execution network requires an exact name and id");
  }
  return { name, id };
}

function containerUser(): { uid: number; gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || (uid as number) < 1 || (gid as number) < 1) {
    throw new Error("container execution requires a non-root host identity");
  }
  return { uid: uid as number, gid: gid as number };
}

function assertProjectionPaths(descriptor: ExactDelegatedRuntimeDescriptor): void {
  const workspace = resolve(workspaceRoot());
  if (process.platform === "win32" || !isAbsolute(workspace) || !workspace.startsWith("/")) {
    throw new Error("container execution requires a POSIX host workspace path");
  }
  const surface = descriptor.surface;
  if (!surface) return;
  const paths = [surface.security.workspace, surface.security.sessionWorkRoot,
    ...surface.security.allowedPaths.map(entry => entry.path)].filter((path): path is string => !!path);
  for (const path of paths) {
    const rel = relative(workspace, resolve(path));
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("container execution authority escapes the projected workspace");
    }
  }
}

function projectedConfig(): Record<string, unknown> {
  return { authToken: randomBytes(32).toString("hex"), workspace: workspaceRoot() };
}

function copyOptionalJson(source: string, destination: string): void {
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("container projection source is not a bounded regular file");
  }
  if (source.endsWith("settings.json")) {
    const value = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
    writeJson(destination, typeof value.customBaseUrl === "string"
      ? { customBaseUrl: value.customBaseUrl }
      : {});
  } else {
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function projectLocalRuntime(
  descriptor: ExactDelegatedRuntimeDescriptor,
  secrets: string,
): string | null {
  if (descriptor.target.kind !== "local-runtime") return null;
  if (!process.env.LAX_CONTAINER_HOST_GATEWAY?.trim() || !configuredNetwork()) {
    throw new Error("local container execution requires an explicit host gateway and network");
  }
  const runtime = getLocalRuntimeById(descriptor.target.runtimeId);
  if (!runtime || !runtime.models.some(model => model.id === descriptor.model)) {
    throw new Error("recorded local runtime is unavailable for container projection");
  }
  const path = join(secrets, "local-runtime.json");
  writeJson(path, runtime);
  return path;
}
