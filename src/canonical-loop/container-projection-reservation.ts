import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeDurableRecordMac,
  verifyDurableRecordMac,
} from "../app-runtime/audit-signing.js";
import type { ContainerLaunchProjection } from "./container-execution-backend.js";

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
  writeFileSync(join(root, "reservation.json"), JSON.stringify({ ...payload,
    mac: computeDurableRecordMac(DOMAIN, JSON.stringify(payload)) }), { mode: 0o600, flag: "wx" });
}

export function reopenReservedProjection(
  root: string,
  projectionId: string,
  opId: string,
  descriptorMac: string,
): ContainerLaunchProjection | null {
  if (existsSync(join(root, "projection.json"))) return null;
  const reservation = readReservation(root);
  if (reservation.projectionId !== projectionId || reservation.opId !== opId
    || reservation.descriptorMac !== descriptorMac) {
    throw new Error("container projection reservation identity changed");
  }
  return {
    durableId: projectionId,
    buildSpec() { throw new Error("container projection creation was interrupted"); },
    writeBootstrap() { throw new Error("container projection creation was interrupted"); },
    cleanup() {
      readReservation(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
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
