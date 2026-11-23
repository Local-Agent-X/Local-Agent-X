/**
 * What a container spec must be before Docker is asked to create it: a safe
 * name, an image pinned by digest, no network or only the one the policy
 * approves, bounded memory and process counts, a non-root user when one is
 * given, and labels and environment Docker cannot misread. Bind mounts are
 * judged by docker-mount-lease.ts. The runtime (docker-execution-runtime.ts)
 * refuses a spec that fails here before it runs a single docker command.
 */
import { validateMountShape } from "./docker-mount-lease.js";
import type { DockerContainerSpec, DockerExecutionPolicy } from "./docker-execution-runtime.js";

/** `sha256:` and 64 hex digits: an image or content digest. */
export const DOCKER_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
/** An image reference pinned by digest: `<repository>@sha256:<64 hex>`. */
export const DOCKER_PINNED_IMAGE = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/;
/** A container name Docker accepts and no shell or path can misread. */
export const DOCKER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Throws, naming the first rule the spec breaks. */
export function validateContainerSpec(spec: DockerContainerSpec, policy: DockerExecutionPolicy): void {
  if (!DOCKER_NAME_PATTERN.test(spec.name)) throw new Error("invalid container execution name");
  if (!DOCKER_PINNED_IMAGE.test(spec.image.reference) || !DOCKER_SHA256_DIGEST.test(spec.image.requestedDigest)
    || !DOCKER_SHA256_DIGEST.test(spec.image.imageId)) throw new Error("invalid container execution image identity");
  if (spec.network !== "none" && !NETWORK_NAME.test(spec.network.name)) {
    throw new Error("invalid container execution network");
  }
  if (spec.network !== "none" && (policy.allowedNetwork === null
    || spec.network.name !== policy.allowedNetwork.name
    || ["host", "default", "bridge", "none"].includes(spec.network.name.toLowerCase()))) {
    throw new Error("container execution network is not approved");
  }
  if (!validMemoryLimit(spec.memoryLimit)) throw new Error("invalid container memory limit");
  if (spec.user && (!Number.isSafeInteger(spec.user.uid) || spec.user.uid < 1
    || !Number.isSafeInteger(spec.user.gid) || spec.user.gid < 1)) {
    throw new Error("invalid non-root container user");
  }
  if (!Number.isSafeInteger(spec.pidsLimit) || spec.pidsLimit < 16 || spec.pidsLimit > 4096) {
    throw new Error("invalid container pid limit");
  }
  for (const [key, value] of [...Object.entries(spec.environment), ...Object.entries(spec.labels)]) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || value.includes("\0") || value.includes("\n")) {
      throw new Error("invalid container execution metadata");
    }
  }
  for (const mount of spec.mounts) validateMountShape(mount);
}

/** Between 64 MiB and 64 GiB, written as Docker's `--memory` takes it. */
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
