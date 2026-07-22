import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { computeDurableRecordMac, verifyDurableRecordMac } from "../app-runtime/audit-signing.js";
import { opDir } from "../ops/event-log.js";
import { ensureDurableDirectory, fsyncDirectory } from "../persistence/durable-directory.js";
import type { DockerContainerIdentity } from "../sandbox/docker-execution-runtime.js";
import type { ExecutionPlacement } from "./types.js";

const DOMAIN = "canonical-container-launch-v1";

export interface ContainerLaunchIntent {
  schemaVersion: 1;
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  name: string;
  imageReference: string;
  imageId: string;
  container?: DockerContainerIdentity;
  mac: string;
}

export function createContainerLaunchIntent(input: {
  opId: string;
  placement: ExecutionPlacement;
  token: string;
  name: string;
  imageReference: string;
  imageId: string;
}): ContainerLaunchIntent {
  return seal({ schemaVersion: 1, opId: input.opId, backendId: input.placement.backendId,
    targetId: input.placement.targetId, placementRevision: input.placement.revision,
    token: input.token, name: input.name, imageReference: input.imageReference, imageId: input.imageId });
}

export function readContainerLaunchIntent(opId: string): ContainerLaunchIntent | null {
  const path = intentPath(opId);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as ContainerLaunchIntent;
  validate(value, opId);
  return value;
}

export function writeContainerLaunchIntent(intent: ContainerLaunchIntent): void {
  validate(intent, intent.opId);
  const path = intentPath(intent.opId);
  ensureDurableDirectory(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(intent), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}

export function bindContainerLaunchIntent(
  intent: ContainerLaunchIntent,
  container: DockerContainerIdentity,
): ContainerLaunchIntent {
  return seal({ ...unsigned(intent), container });
}

export function removeContainerLaunchIntent(expected: ContainerLaunchIntent): boolean {
  const current = readContainerLaunchIntent(expected.opId);
  if (!current || current.mac !== expected.mac) return false;
  rmSync(intentPath(expected.opId));
  fsyncDirectory(dirname(intentPath(expected.opId)));
  return true;
}

export function intentMatchesPlacement(
  intent: ContainerLaunchIntent,
  placement: ExecutionPlacement,
  imageReference: string,
  imageId: string,
): boolean {
  return intent.backendId === placement.backendId && intent.targetId === placement.targetId
    && intent.placementRevision === placement.revision && intent.imageReference === imageReference
    && intent.imageId === imageId;
}

function validate(intent: ContainerLaunchIntent, opId: string): void {
  if (!intent || intent.schemaVersion !== 1 || intent.opId !== opId || !intent.backendId
    || !intent.targetId || !Number.isSafeInteger(intent.placementRevision) || intent.placementRevision < 1
    || !intent.token || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(intent.name)
    || !intent.imageReference || !/^sha256:[a-f0-9]{64}$/.test(intent.imageId)
    || !/^[a-f0-9]{64}$/.test(intent.mac)) throw new Error("invalid container launch intent");
  if (intent.container && (intent.container.imageId !== intent.imageId
    || !/^[a-f0-9]{64}$/.test(intent.container.containerId)
    || !Number.isFinite(Date.parse(intent.container.createdAt)))) {
    throw new Error("invalid container launch identity");
  }
  const { mac, ...payload } = intent;
  if (!verifyDurableRecordMac(DOMAIN, stable(payload), mac)) throw new Error("container launch intent integrity failed");
}

function seal(payload: Omit<ContainerLaunchIntent, "mac">): ContainerLaunchIntent {
  return { ...payload, mac: computeDurableRecordMac(DOMAIN, stable(payload)) };
}

function unsigned(intent: ContainerLaunchIntent): Omit<ContainerLaunchIntent, "mac"> {
  const { mac: _mac, ...payload } = intent;
  return payload;
}

function intentPath(opId: string): string {
  return join(opDir(opId), "container-launch.json");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
