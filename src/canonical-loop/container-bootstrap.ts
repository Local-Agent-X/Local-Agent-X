import { computeDurableRecordMac, verifyDurableRecordMac } from "../app-runtime/audit-signing.js";

const DOMAIN = "canonical-container-bootstrap-v1";

export interface ContainerBootstrap {
  schemaVersion: 1;
  opId: string;
  backendId: string;
  targetId: string;
  placementRevision: number;
  token: string;
  containerId: string;
  containerCreatedAt: string;
  imageDigest: string;
}

interface SealedContainerBootstrap { bootstrap: ContainerBootstrap; mac: string }

export function sealContainerBootstrap(bootstrap: ContainerBootstrap): SealedContainerBootstrap {
  validate(bootstrap);
  return { bootstrap, mac: computeDurableRecordMac(DOMAIN, JSON.stringify(bootstrap)) };
}

export function verifyContainerBootstrap(value: unknown): ContainerBootstrap {
  const sealed = value as Partial<SealedContainerBootstrap> | null;
  const bootstrap = sealed?.bootstrap;
  validate(bootstrap);
  if (typeof sealed?.mac !== "string"
    || !verifyDurableRecordMac(DOMAIN, JSON.stringify(bootstrap), sealed.mac)) {
    throw new Error("container bootstrap integrity check failed");
  }
  return bootstrap as ContainerBootstrap;
}

function validate(value: unknown): asserts value is ContainerBootstrap {
  const b = value as Partial<ContainerBootstrap> | null;
  if (!b || b.schemaVersion !== 1 || !nonEmpty(b.opId) || !nonEmpty(b.backendId)
    || !nonEmpty(b.targetId) || !Number.isSafeInteger(b.placementRevision) || (b.placementRevision as number) < 1
    || !nonEmpty(b.token) || typeof b.containerId !== "string" || !/^[a-f0-9]{64}$/.test(b.containerId)
    || !canonicalIso(b.containerCreatedAt) || typeof b.imageDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(b.imageDigest)) throw new Error("invalid container bootstrap");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
