import { execFile, type ExecFileOptions } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PINNED_IMAGE = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

export type DockerCommandRunner = (
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<DockerCommandResult>;

export interface DockerImageIdentity {
  reference: string;
  requestedDigest: string;
  imageId: string;
}

export interface DockerContainerIdentity {
  containerId: string;
  createdAt: string;
  imageId: string;
}

export interface DockerBindMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface DockerContainerSpec {
  name: string;
  image: DockerImageIdentity;
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  mounts: readonly DockerBindMount[];
  network: "none" | { name: string };
  memoryLimit: string;
  pidsLimit: number;
  labels: Readonly<Record<string, string>>;
}

export interface DockerContainerState extends DockerContainerIdentity {
  running: boolean;
  exitCode: number | null;
}

export interface DockerExecutionRuntime {
  probe(): Promise<boolean>;
  resolvePinnedImage(reference: string): Promise<DockerImageIdentity>;
  create(spec: DockerContainerSpec): Promise<DockerContainerIdentity>;
  start(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<DockerContainerState | null>;
  inspectNamed(name: string, labels: Readonly<Record<string, string>>): Promise<DockerContainerState | null>;
  wait(containerId: string): Promise<number>;
  stop(containerId: string): Promise<void>;
}

export interface DockerExecutionPolicy {
  approvedMountRoots: readonly string[];
  allowedNetwork: string | null;
}

export function createDockerCommandRunner(binary = "docker"): DockerCommandRunner {
  return async (args, options = {}) => {
    const execOptions: ExecFileOptions = {
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 2 * 1024 * 1024,
    };
    const result = await execFileAsync(binary, [...args], execOptions);
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };
}

export class DockerCliExecutionRuntime implements DockerExecutionRuntime {
  constructor(
    private readonly run: DockerCommandRunner = createDockerCommandRunner(),
    private readonly policy: DockerExecutionPolicy = { approvedMountRoots: [], allowedNetwork: null },
  ) {}

  async probe(): Promise<boolean> {
    try {
      await this.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async resolvePinnedImage(reference: string): Promise<DockerImageIdentity> {
    const parsed = PINNED_IMAGE.exec(reference);
    if (!parsed) throw new Error("container execution image must be pinned by sha256 digest");
    const requestedDigest = parsed[2];
    const result = await this.run([
      "image", "inspect", reference,
      "--format", "{{json .RepoDigests}}\n{{.Id}}",
    ]);
    const [repoDigestsRaw, imageIdRaw] = result.stdout.trim().split(/\r?\n/);
    let repoDigests: unknown;
    try { repoDigests = JSON.parse(repoDigestsRaw ?? "null"); }
    catch { throw new Error("Docker returned ambiguous image digest metadata"); }
    const imageId = imageIdRaw?.trim();
    if (!Array.isArray(repoDigests) || !repoDigests.includes(reference) || !imageId || !SHA256.test(imageId)) {
      throw new Error("Docker image does not match the pinned execution image");
    }
    return { reference, requestedDigest, imageId };
  }

  async create(spec: DockerContainerSpec): Promise<DockerContainerIdentity> {
    validateSpec(spec, this.policy);
    const network = spec.network === "none" ? "none" : await this.resolveApprovedNetwork(spec.network.name);
    const args = [
      "create", "--name", spec.name,
      "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--user", "1000:1000",
      "--pids-limit", String(spec.pidsLimit),
      "--memory", spec.memoryLimit,
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--network", network,
    ];
    for (const [key, value] of Object.entries(spec.labels).sort(([a], [b]) => a.localeCompare(b))) {
      args.push("--label", `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.environment).sort(([a], [b]) => a.localeCompare(b))) {
      args.push("--env", `${key}=${value}`);
    }
    for (const mount of spec.mounts) {
      args.push("--mount", bindMountArg(mount));
    }
    args.push(spec.image.reference, ...spec.command);
    const created = (await this.run(args, { timeoutMs: 60_000 })).stdout.trim();
    if (!CONTAINER_ID.test(created)) throw new Error("Docker returned an ambiguous container id");
    const identity = await this.inspect(created);
    if (!identity || identity.imageId !== spec.image.imageId) {
      await this.stop(created);
      throw new Error("created container image identity changed");
    }
    return identity;
  }

  private async resolveApprovedNetwork(name: string): Promise<string> {
    const result = await this.run([
      "network", "inspect", name,
      "--format", "{{.Id}}\n{{.Name}}\n{{.Driver}}\n{{.Scope}}\n{{.Internal}}",
    ]);
    const [id, actualName, driver, scope, internal] = result.stdout.trim().split(/\r?\n/);
    if (!/^[a-f0-9]{64}$/.test(id ?? "") || actualName !== name || driver !== "bridge"
      || scope !== "local" || internal !== "false") {
      throw new Error("container execution network properties are not approved");
    }
    return id;
  }

  async start(containerId: string): Promise<void> {
    assertContainerId(containerId);
    await this.run(["start", containerId], { timeoutMs: 60_000 });
  }

  async inspect(containerId: string): Promise<DockerContainerState | null> {
    assertContainerId(containerId);
    try {
      const result = await this.run([
        "container", "inspect", containerId,
        "--format", "{{.Id}}\n{{.Created}}\n{{.Image}}\n{{.State.Running}}\n{{.State.ExitCode}}",
      ]);
      const [id, createdAt, imageId, runningRaw, exitRaw] = result.stdout.trim().split(/\r?\n/);
      if (id !== containerId) throw new Error("Docker returned ambiguous container metadata");
      return parseContainerState(containerId, createdAt, imageId, runningRaw, exitRaw);
    } catch (error) {
      if (isNoSuchContainer(error)) return null;
      throw error;
    }
  }

  async inspectNamed(name: string, labels: Readonly<Record<string, string>>): Promise<DockerContainerState | null> {
    if (!DOCKER_NAME.test(name)) throw new Error("invalid container execution name");
    try {
      const result = await this.run([
        "container", "inspect", name,
        "--format", "{{.Id}}\n{{.Created}}\n{{.Image}}\n{{.State.Running}}\n{{.State.ExitCode}}\n{{.Name}}\n{{json .Config.Labels}}",
      ]);
      const [id, createdAt, imageId, runningRaw, exitRaw, actualName, labelsRaw] = result.stdout.trim().split(/\r?\n/);
      if (!CONTAINER_ID.test(id ?? "") || actualName !== `/${name}`) {
        throw new Error("Docker returned ambiguous named container metadata");
      }
      let actualLabels: unknown;
      try { actualLabels = JSON.parse(labelsRaw ?? "null"); }
      catch { throw new Error("Docker returned ambiguous named container labels"); }
      if (!actualLabels || typeof actualLabels !== "object"
        || Object.entries(labels).some(([key, value]) => (actualLabels as Record<string, unknown>)[key] !== value)) {
        throw new Error("named container ownership labels changed");
      }
      return parseContainerState(id, createdAt, imageId, runningRaw, exitRaw);
    } catch (error) {
      if (isNoSuchContainer(error)) return null;
      throw error;
    }
  }

  async wait(containerId: string): Promise<number> {
    assertContainerId(containerId);
    const raw = (await this.run(["wait", containerId], { timeoutMs: 0 })).stdout.trim();
    if (!/^\d+$/.test(raw)) throw new Error("Docker returned an ambiguous container exit code");
    return Number(raw);
  }

  async stop(containerId: string): Promise<void> {
    assertContainerId(containerId);
    try { await this.run(["rm", "--force", containerId], { timeoutMs: 30_000 }); }
    catch (error) { if (!isNoSuchContainer(error)) throw error; }
  }
}

function validateSpec(spec: DockerContainerSpec, policy: DockerExecutionPolicy): void {
  if (!DOCKER_NAME.test(spec.name)) throw new Error("invalid container execution name");
  if (!PINNED_IMAGE.test(spec.image.reference) || !SHA256.test(spec.image.requestedDigest)
    || !SHA256.test(spec.image.imageId)) throw new Error("invalid container execution image identity");
  if (spec.network !== "none" && !NETWORK_NAME.test(spec.network.name)) {
    throw new Error("invalid container execution network");
  }
  if (spec.network !== "none" && (policy.allowedNetwork === null
    || spec.network.name !== policy.allowedNetwork
    || ["host", "default", "bridge", "none"].includes(spec.network.name.toLowerCase()))) {
    throw new Error("container execution network is not approved");
  }
  if (!validMemoryLimit(spec.memoryLimit)) throw new Error("invalid container memory limit");
  if (!Number.isSafeInteger(spec.pidsLimit) || spec.pidsLimit < 16 || spec.pidsLimit > 4096) {
    throw new Error("invalid container pid limit");
  }
  for (const [key, value] of [...Object.entries(spec.environment), ...Object.entries(spec.labels)]) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || value.includes("\0") || value.includes("\n")) {
      throw new Error("invalid container execution metadata");
    }
  }
  for (const mount of spec.mounts) {
    if (!mount.source || !/^\/[A-Za-z0-9._/-]+$/.test(mount.target)
      || mount.target === "/" || mount.source.includes("\0") || mount.target.includes("..")) {
      throw new Error("invalid container execution mount");
    }
    const source = resolve(mount.source);
    if (mount.target === "/var/run/docker.sock" || dockerSocketPath(source)) {
      throw new Error("Docker socket mount is forbidden");
    }
    let canonical: string;
    try { canonical = realpathSync(source); }
    catch { throw new Error("container execution mount source is unavailable"); }
    if (dockerSocketPath(canonical)) {
      throw new Error("Docker socket mount is forbidden");
    }
    const sourceType = lstatSync(canonical);
    if (!sourceType.isFile() && !sourceType.isDirectory()) {
      throw new Error("container execution mount source must be a regular file or directory");
    }
    const roots = policy.approvedMountRoots.map(root => {
      try { return realpathSync(resolve(root)); }
      catch { throw new Error("approved container mount root is unavailable"); }
    });
    if (!roots.some(root => canonical === root || canonical.startsWith(root.endsWith(sep) ? root : root + sep))) {
      throw new Error("container execution mount source is outside approved roots");
    }
  }
}

function validMemoryLimit(value: string): boolean {
  const match = /^(\d+)([kmg])?$/i.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === "g" ? 1024 ** 3
    : match[2]?.toLowerCase() === "m" ? 1024 ** 2
      : match[2]?.toLowerCase() === "k" ? 1024 : 1;
  const bytes = amount * multiplier;
  return Number.isSafeInteger(bytes) && bytes >= 64 * 1024 ** 2 && bytes <= 64 * 1024 ** 3;
}

function dockerSocketPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().endsWith("/docker.sock");
}

function bindMountArg(mount: DockerBindMount): string {
  return `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`;
}

function assertContainerId(containerId: string): void {
  if (!CONTAINER_ID.test(containerId)) throw new Error("invalid container id");
}

function parseContainerState(
  containerId: string,
  createdAt: string | undefined,
  imageId: string | undefined,
  runningRaw: string | undefined,
  exitRaw: string | undefined,
): DockerContainerState {
  if (!canonicalIso(createdAt) || !SHA256.test(imageId ?? "")
    || (runningRaw !== "true" && runningRaw !== "false") || !/^-?\d+$/.test(exitRaw ?? "")) {
    throw new Error("Docker returned ambiguous container metadata");
  }
  const running = runningRaw === "true";
  return { containerId, createdAt, imageId: imageId!, running, exitCode: running ? null : Number(exitRaw) };
}

function canonicalIso(value: string | undefined): value is string {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNoSuchContainer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (?:object|container)/i.test(message);
}
