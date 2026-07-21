import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteFileSync } from "../server-utils.js";
import { withLearnedLifecycleTransaction } from "./learned-lifecycle-transaction.js";
import { learnedProtocolsDir } from "./loader.js";
import { parseSkillMd } from "./skill-md-parser.js";

export type LearnedProtocolState = "draft" | "active" | "archived";

export interface LearnedProtocolVersion {
  id: string; sha256: string; createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ActiveLearnedProtocolProvenance {
  slug: string; versionId: string; candidateId: string; allowedTools: string[];
}

export type LearnedActivationKind = "activate" | "restore" | "rollback" | "archive";

export interface LearnedActivationHistoryEntry {
  kind: LearnedActivationKind; versionId: string; previousVersionId: string | null;
  timestamp: number; reason: string;
}

export interface LearnedProtocolRecord {
  schemaVersion: 1; slug: string; state: LearnedProtocolState; activeVersionId: string | null;
  versions: LearnedProtocolVersion[];
  activationHistory?: LearnedActivationHistoryEntry[];
}

export interface LearnedMutation {
  slug: string; expectedActiveVersionId: string | null; reason?: string; timestamp?: number;
}

const MAX_ACTIVATION_HISTORY = 100;
const ACTIVATION_KINDS = new Set<LearnedActivationKind>(["activate", "restore", "rollback", "archive"]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Invalid learned protocol slug: ${slug}`);
  }
}

function assertContained(base: string, candidate: string): void {
  const root = resolve(base);
  const target = resolve(candidate);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("Learned protocol path escapes the imported protocol directory");
  }
}

function rejectSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing symbolic link: ${basename(path)}`);
  }
}

function protocolDir(slug: string): string {
  assertSlug(slug);
  const base = learnedProtocolsDir();
  const dir = join(base, slug);
  assertContained(base, dir);
  rejectSymlink(base);
  rejectSymlink(dir);
  return dir;
}

function lifecyclePath(dir: string): string {
  return join(dir, "learned.json");
}

function versionDir(dir: string, versionId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(versionId)) throw new Error("Invalid learned protocol version id");
  const versions = join(dir, "versions");
  const target = join(versions, versionId);
  assertContained(dir, target);
  rejectSymlink(versions);
  rejectSymlink(target);
  return target;
}

function readRecord(slug: string): { dir: string; record: LearnedProtocolRecord } {
  const dir = protocolDir(slug);
  const path = lifecyclePath(dir);
  rejectSymlink(path);
  if (!existsSync(path)) throw new Error(`Learned protocol not found: ${slug}`);
  const record = JSON.parse(readFileSync(path, "utf8")) as LearnedProtocolRecord;
  if (record.schemaVersion !== 1 || record.slug !== slug || !Array.isArray(record.versions)) {
    throw new Error(`Invalid learned protocol record: ${slug}`);
  }
  if (record.activationHistory !== undefined) validateActivationHistory(record, slug);
  return { dir, record };
}

function validateActivationHistory(record: LearnedProtocolRecord, slug: string): void {
  const value = record.activationHistory;
  if (!Array.isArray(value) || value.length > MAX_ACTIVATION_HISTORY) {
    throw new Error(`Invalid learned protocol activation history: ${slug}`);
  }
  const versionIds = new Set(record.versions.map((version) => version.id));
  let priorTimestamp = 0;
  let trackedVersion: string | null | undefined;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid learned protocol activation history: ${slug}`);
    const item = entry as unknown as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !== "kind,previousVersionId,reason,timestamp,versionId"
      || !ACTIVATION_KINDS.has(item.kind as LearnedActivationKind)
      || typeof item.versionId !== "string"
      || !versionIds.has(item.versionId)
      || (item.previousVersionId !== null && (typeof item.previousVersionId !== "string" || !versionIds.has(item.previousVersionId)))
      || typeof item.timestamp !== "number"
      || !Number.isFinite(item.timestamp)
      || item.timestamp <= 0
      || typeof item.reason !== "string"
      || item.reason.trim().length === 0
      || item.reason.length > 200
      || (item.kind === "archive" && item.previousVersionId !== item.versionId)
      || (trackedVersion !== undefined && item.previousVersionId !== trackedVersion)
      || (item.timestamp as number) < priorTimestamp
    ) throw new Error(`Invalid learned protocol activation history: ${slug}`);
    trackedVersion = item.versionId as string;
    priorTimestamp = item.timestamp as number;
  }
  if (value.length > 0 && trackedVersion !== record.activeVersionId) {
    throw new Error(`Invalid learned protocol activation history: ${slug}`);
  }
}

function recordActivation(
  record: LearnedProtocolRecord, kind: LearnedActivationKind, versionId: string,
  previousVersionId: string | null, reason: string | undefined, timestamp: number | undefined,
): void {
  const at = timestamp ?? Date.now();
  const why = reason?.trim() || `${kind[0].toUpperCase()}${kind.slice(1)} learned protocol`;
  if (!Number.isFinite(at) || at <= 0 || why.length > 200) throw new Error("Invalid learned protocol activation history entry");
  record.activationHistory = [
    ...(record.activationHistory ?? []),
    { kind, versionId, previousVersionId, timestamp: at, reason: why },
  ].slice(-MAX_ACTIVATION_HISTORY);
}

function readVerifiedVersion(dir: string, version: LearnedProtocolVersion): string {
  const vDir = versionDir(dir, version.id);
  const skillPath = join(vDir, "SKILL.md");
  const metaPath = join(vDir, "meta.json");
  rejectSymlink(skillPath);
  rejectSymlink(metaPath);
  if (!existsSync(skillPath) || !existsSync(metaPath)) throw new Error(`Incomplete learned protocol version: ${version.id}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as LearnedProtocolVersion;
  const body = readFileSync(skillPath, "utf8");
  if (JSON.stringify(meta) !== JSON.stringify(version) || sha256(body) !== version.sha256) {
    throw new Error(`Learned protocol version hash mismatch: ${version.id}`);
  }
  return body;
}

function compareActive(record: LearnedProtocolRecord, expected: string | null): void {
  if (record.activeVersionId !== expected) {
    throw new Error(`Active learned protocol version changed: expected ${expected ?? "none"}, found ${record.activeVersionId ?? "none"}`);
  }
}

function saveRecord(dir: string, record: LearnedProtocolRecord): void {
  atomicWriteFileSync(lifecyclePath(dir), JSON.stringify(record, null, 2), { mode: 0o600 });
}

function materialize(dir: string, body: string): void {
  const rootSkill = join(dir, "SKILL.md");
  rejectSymlink(rootSkill);
  atomicWriteFileSync(rootSkill, body, { mode: 0o600 });
}

function materializeAndSave(dir: string, record: LearnedProtocolRecord, body: string): void {
  const rootSkill = join(dir, "SKILL.md");
  rejectSymlink(rootSkill);
  const previous = existsSync(rootSkill) ? readFileSync(rootSkill, "utf8") : null;
  materialize(dir, body);
  try {
    saveRecord(dir, record);
  } catch (error) {
    if (previous === null) rmSync(rootSkill, { force: true });
    else materialize(dir, previous);
    throw error;
  }
}

export function createLearnedProtocolDraft(input: {
  slug: string; skillMd: string;
  metadata?: Record<string, unknown>;
}): { record: LearnedProtocolRecord; version: LearnedProtocolVersion } {
  return withLearnedLifecycleTransaction(() => createDraft(input));
}

function createDraft(input: {
  slug: string; skillMd: string;
  metadata?: Record<string, unknown>;
}): { record: LearnedProtocolRecord; version: LearnedProtocolVersion } {
  const dir = protocolDir(input.slug);
  const recordPath = lifecyclePath(dir);
  let record: LearnedProtocolRecord;
  if (existsSync(dir)) {
    if (!existsSync(recordPath)) throw new Error(`Imported protocol collision: ${input.slug}`);
    record = loadLearnedProtocol(input.slug);
  } else {
    mkdirSync(dir, { recursive: true });
    record = { schemaVersion: 1, slug: input.slug, state: "draft", activeVersionId: null, versions: [] };
  }

  const digest = sha256(input.skillMd);
  const metadata = input.metadata ?? {};
  const duplicate = record.versions.find((candidate) =>
    candidate.sha256 === digest && isDeepStrictEqual(candidate.metadata, metadata));
  if (duplicate) return { record, version: duplicate };

  const version: LearnedProtocolVersion = {
    id: randomUUID(),
    sha256: digest,
    createdAt: new Date().toISOString(),
    metadata,
  };
  const vDir = versionDir(dir, version.id);
  if (existsSync(vDir)) throw new Error(`Learned protocol version collision: ${version.id}`);
  if (!existsSync(join(dir, "versions"))) mkdirSync(join(dir, "versions"), { recursive: false });
  mkdirSync(vDir, { recursive: false });
  try {
    atomicWriteFileSync(join(vDir, "SKILL.md"), input.skillMd, { mode: 0o600 });
    atomicWriteFileSync(join(vDir, "meta.json"), JSON.stringify(version, null, 2), { mode: 0o600 });
    record.versions.push(version);
    saveRecord(dir, record);
  } catch (error) {
    rmSync(vDir, { recursive: true, force: true });
    throw error;
  }
  return { record, version };
}

export function loadLearnedProtocol(slug: string): LearnedProtocolRecord {
  const { dir, record } = readRecord(slug);
  if (!["draft", "active", "archived"].includes(record.state)) {
    throw new Error(`Invalid learned protocol state: ${slug}`);
  }
  const ids = new Set<string>();
  for (const version of record.versions) {
    if (ids.has(version.id)) throw new Error(`Duplicate learned protocol version: ${version.id}`);
    ids.add(version.id);
    readVerifiedVersion(dir, version);
  }
  const rootSkill = join(dir, "SKILL.md");
  rejectSymlink(rootSkill);
  if (record.state === "active") {
    const active = record.versions.find((version) => version.id === record.activeVersionId);
    if (!active) throw new Error(`Active learned protocol version is missing: ${slug}`);
    if (!existsSync(rootSkill) || sha256(readFileSync(rootSkill, "utf8")) !== active.sha256) {
      throw new Error(`Active learned protocol materialization mismatch: ${slug}`);
    }
  } else if (existsSync(rootSkill)) {
    throw new Error(`Inactive learned protocol has a materialized SKILL.md: ${slug}`);
  } else if (record.state === "draft" && record.activeVersionId !== null) {
    throw new Error(`Draft learned protocol has an active version: ${slug}`);
  } else if (record.state === "archived" && !record.activeVersionId) {
    throw new Error(`Archived learned protocol has no restorable version: ${slug}`);
  }
  return record;
}

export function hasLearnedProtocol(slug: string): boolean {
  const dir = protocolDir(slug);
  const path = lifecyclePath(dir);
  rejectSymlink(path);
  return existsSync(path);
}

function activateVersion(input: LearnedMutation & { versionId: string },
  kind: Exclude<LearnedActivationKind, "archive">): LearnedProtocolRecord {
  loadLearnedProtocol(input.slug);
  const { dir, record } = readRecord(input.slug);
  compareActive(record, input.expectedActiveVersionId);
  const version = record.versions.find((candidate) => candidate.id === input.versionId);
  if (!version) throw new Error(`Unknown learned protocol version: ${input.versionId}`);
  const body = readVerifiedVersion(dir, version);
  const previousVersionId = record.activeVersionId;
  record.state = "active";
  record.activeVersionId = version.id;
  recordActivation(record, kind, version.id, previousVersionId, input.reason, input.timestamp);
  materializeAndSave(dir, record, body);
  return record;
}

export function activateLearnedProtocol(input: LearnedMutation & { versionId: string }): LearnedProtocolRecord {
  return withLearnedLifecycleTransaction(() => activateVersion(input, "activate"));
}

export function archiveLearnedProtocol(input: LearnedMutation): LearnedProtocolRecord {
  return withLearnedLifecycleTransaction(() => archiveProtocol(input));
}

function archiveProtocol(input: LearnedMutation): LearnedProtocolRecord {
  loadLearnedProtocol(input.slug);
  const { dir, record } = readRecord(input.slug);
  compareActive(record, input.expectedActiveVersionId);
  if (record.state !== "active" || !record.activeVersionId) throw new Error(`Learned protocol is not active: ${input.slug}`);
  const rootSkill = join(dir, "SKILL.md");
  rejectSymlink(rootSkill);
  if (!existsSync(rootSkill)) throw new Error(`Active learned protocol materialization is missing: ${input.slug}`);
  const hidden = join(dir, `.SKILL.md.archive-${randomUUID()}`);
  renameSync(rootSkill, hidden);
  record.state = "archived";
  recordActivation(record, "archive", record.activeVersionId, record.activeVersionId, input.reason, input.timestamp);
  try {
    saveRecord(dir, record);
  } catch (error) {
    renameSync(hidden, rootSkill);
    throw error;
  }
  rmSync(hidden);
  return record;
}

export function restoreLearnedProtocol(input: LearnedMutation): LearnedProtocolRecord {
  return withLearnedLifecycleTransaction(() => {
    const record = loadLearnedProtocol(input.slug);
    compareActive(record, input.expectedActiveVersionId);
    if (record.state !== "archived" || !record.activeVersionId) throw new Error(`Learned protocol is not archived: ${input.slug}`);
    return activateVersion({ ...input, versionId: record.activeVersionId }, "restore");
  });
}

export function rollbackLearnedProtocol(input: LearnedMutation & { versionId: string }): LearnedProtocolRecord {
  return withLearnedLifecycleTransaction(() => {
    const record = loadLearnedProtocol(input.slug);
    if (record.state !== "active") throw new Error(`Learned protocol is not active: ${input.slug}`);
    return activateVersion(input, "rollback");
  });
}

export function activeLearnedProtocolProvenance(slug: string): ActiveLearnedProtocolProvenance {
  const record = loadLearnedProtocol(slug);
  if (record.state !== "active" || !record.activeVersionId) {
    throw new Error(`Learned protocol is not active: ${slug}`);
  }
  const version = record.versions.find((candidate) => candidate.id === record.activeVersionId);
  if (!version) throw new Error(`Active learned protocol version is missing: ${slug}`);
  const candidateId = version.metadata.candidateId;
  const allowedTools = version.metadata.allowedTools;
  const toolSequence = version.metadata.toolSequence;
  if (typeof candidateId !== "string" || candidateId !== slug || !/^learned-[a-f0-9]{20}$/.test(candidateId)) {
    throw new Error(`Learned protocol candidate provenance is missing: ${slug}`);
  }
  if (
    !Array.isArray(allowedTools)
    || allowedTools.some((tool) => typeof tool !== "string")
    || !Array.isArray(toolSequence)
    || toolSequence.some((tool) => typeof tool !== "string")
  ) {
    throw new Error(`Learned protocol capability metadata is invalid: ${slug}`);
  }
  const normalized = [...new Set(toolSequence.map((tool) => tool.trim()).filter(Boolean))];
  if (JSON.stringify(allowedTools) !== JSON.stringify(normalized)) {
    throw new Error(`Learned protocol capability metadata does not match its evidence: ${slug}`);
  }
  const { dir } = readRecord(slug);
  const body = readVerifiedVersion(dir, version);
  const parsed = parseSkillMd(body, { source: { type: "imported" }, fallbackName: slug });
  if (!parsed || parsed.name !== slug || JSON.stringify(parsed.allowedTools ?? []) !== JSON.stringify(allowedTools)) {
    throw new Error(`Learned protocol capability metadata does not match its verified body: ${slug}`);
  }
  return {
    slug,
    versionId: version.id,
    candidateId,
    allowedTools: normalized,
  };
}

export function resolveActiveLearnedProtocolProvenance(
  sourcePath: string,
  protocolName: string,
): ActiveLearnedProtocolProvenance | null {
  const base = resolve(learnedProtocolsDir());
  const dir = resolve(sourcePath, "..");
  const slug = basename(dir);
  if (dir !== base && !dir.startsWith(base + sep)) return null;
  rejectSymlink(base);
  rejectSymlink(dir);
  if (resolve(sourcePath) !== join(dir, "SKILL.md")) throw new Error("Imported protocol source path is invalid");
  rejectSymlink(sourcePath);
  if (!existsSync(lifecyclePath(dir))) return null;
  const expectedDir = protocolDir(slug);
  if (dir !== expectedDir) throw new Error("Learned protocol source path does not match its managed slug");
  if (protocolName !== slug) throw new Error(`Learned protocol name does not match its slug: ${slug}`);
  return activeLearnedProtocolProvenance(slug);
}
