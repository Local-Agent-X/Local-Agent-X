import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  computeDurableRecordMac,
  verifyDurableRecordMac,
} from "../app-runtime/audit-signing.js";
import type { ContainerLaunchProjection } from "./container-execution-backend.js";
import { fsyncDirectory } from "../persistence/durable-directory.js";

const DOMAIN = "canonical-container-projection-reservation-v1";

interface Reservation {
  schemaVersion: 1;
  projectionId: string;
  opId: string;
  descriptorMac: string;
  mac: string;
}

export function writeProjectionReservation(
  root: string,
  projectionId: string,
  opId: string,
  descriptorMac: string,
): void {
  const payload = { schemaVersion: 1 as const, projectionId, opId, descriptorMac };
  fsyncDirectory(dirname(root));
  writeDurableJson(root, "reservation.json", { ...payload,
    mac: computeDurableRecordMac(DOMAIN, JSON.stringify(payload)) });
}

export function writeProjectionManifest(root: string, value: unknown): void {
  writeDurableJson(root, "projection.json", value);
}

export function removeOwnedProjectionRoot(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("container projection root is invalid");
  }
  rmSync(root, { recursive: true, force: true });
  fsyncDirectory(dirname(root));
}

export function reopenReservedProjection(
  root: string,
  projectionId: string,
  opId: string,
  descriptorMac: string,
): ContainerLaunchProjection | null {
  if (existsSync(join(root, "projection.json"))) return null;
  let reservation: Reservation;
  try { reservation = readReservation(root); }
  catch (error) {
    if (!isRecoverableEmptyReservation(root)) throw error;
    return interruptedProjection(root, projectionId, false);
  }
  if (reservation.projectionId !== projectionId || reservation.opId !== opId
    || reservation.descriptorMac !== descriptorMac) {
    throw new Error("container projection reservation identity changed");
  }
  return interruptedProjection(root, projectionId, true);
}

function interruptedProjection(
  root: string,
  projectionId: string,
  verifyReservation: boolean,
): ContainerLaunchProjection {
  return {
    durableId: projectionId,
    buildSpec() { throw new Error("container projection creation was interrupted"); },
    writeBootstrap() { throw new Error("container projection creation was interrupted"); },
    cleanup() {
      if (verifyReservation) readReservation(root);
      else if (!isRecoverableEmptyReservation(root)) {
        throw new Error("container projection reservation changed before cleanup");
      }
      removeOwnedProjectionRoot(root);
    },
  };
}

function writeDurableJson(root: string, name: string, value: unknown): void {
  const path = join(root, name);
  const tmp = join(root, `${name}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value), "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDirectory(root);
}

function isRecoverableEmptyReservation(root: string): boolean {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  return readdirSync(root).every(name => {
    if (!/^reservation(?:\.\d+\.[a-f0-9-]+\.tmp|\.json)$/.test(name)) return false;
    const stat = lstatSync(join(root, name));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024;
  });
}

function readReservation(root: string): Reservation {
  const rootStat = lstatSync(root);
  const path = join(root, "reservation.json");
  const stat = lstatSync(path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stat.isFile()
    || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new Error("container projection reservation is invalid");
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Reservation>;
  const payload = { schemaVersion: value.schemaVersion, projectionId: value.projectionId,
    opId: value.opId, descriptorMac: value.descriptorMac };
  if (value.schemaVersion !== 1 || typeof value.projectionId !== "string"
    || typeof value.opId !== "string" || !/^[a-f0-9]{64}$/.test(value.descriptorMac ?? "")
    || typeof value.mac !== "string"
    || !verifyDurableRecordMac(DOMAIN, JSON.stringify(payload), value.mac)) {
    throw new Error("container projection reservation integrity check failed");
  }
  return value as Reservation;
}
