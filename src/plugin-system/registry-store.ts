import { readFileSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { atomicWriteFileSync, ensureDirFor } from "../util/json-store.js";
import {
  parsePluginManifestMetadata,
  type PluginManifestMetadata,
} from "./manifest.js";

export interface PluginRegistryEntry {
  enabled: boolean;
  path: string;
  entryHash?: string;
  manifestHash?: string;
  manifest?: PluginManifestMetadata;
}

export interface PluginRegistry {
  [pluginId: string]: PluginRegistryEntry;
}

export interface PluginRegistryStore {
  read(): PluginRegistry;
  write(registry: PluginRegistry): void;
}

const REGISTRY_ERROR_KIND = Symbol.for("local-agent-x.plugin-registry-error");
type RegistryErrorKind = "content-invalid" | "read-unavailable" | "write-unavailable";

function systemErrorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

abstract class PluginRegistryStoreError extends Error {
  readonly [REGISTRY_ERROR_KIND]: RegistryErrorKind;
  readonly code: string | undefined;
  constructor(message: string, kind: RegistryErrorKind, cause?: unknown) {
    super(message, { cause });
    this.name = "PluginRegistryStoreError";
    this[REGISTRY_ERROR_KIND] = kind;
    this.code = systemErrorCode(cause);
  }
}

export class PluginRegistryContentError extends PluginRegistryStoreError {
  constructor(cause?: unknown) { super("Plugin registry is invalid", "content-invalid", cause); }
}

export class PluginRegistryUnavailableError extends PluginRegistryStoreError {
  readonly operation: "read" | "write";
  constructor(operation: "read" | "write", cause?: unknown, message = `Plugin registry ${operation} is temporarily unavailable`) {
    super(message, `${operation}-unavailable`, cause);
    this.operation = operation;
  }
}

export function isPluginRegistryContentError(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as Record<symbol, unknown>)[REGISTRY_ERROR_KIND] === "content-invalid";
}

export function isPluginRegistryUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const kind = (error as Record<symbol, unknown>)[REGISTRY_ERROR_KIND];
  return kind === "read-unavailable" || kind === "write-unavailable";
}

export function normalizePluginRegistryUnavailable(
  operation: "read" | "write", error: unknown, message?: string,
): unknown {
  if (isPluginRegistryUnavailableError(error) && !message) return error;
  return new PluginRegistryUnavailableError(operation, error, message);
}

function parseRegistry(raw: string): PluginRegistry {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plugin registry is invalid");
  }
  const registry = parsed as Record<string, unknown>;
  const normalized: PluginRegistry = {};
  for (const [id, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Plugin registry is invalid");
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.enabled !== "boolean" || typeof value.path !== "string" || !value.path) {
      throw new Error("Plugin registry is invalid");
    }
    for (const key of ["entryHash", "manifestHash"] as const) {
      const hash = value[key];
      if (hash !== undefined && (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash))) {
        throw new Error("Plugin registry is invalid");
      }
    }
    const manifest = value.manifest === undefined
      ? undefined
      : parsePluginManifestMetadata(value.manifest);
    if (manifest && manifest.id !== id) throw new Error("Plugin registry is invalid");
    normalized[id] = {
      enabled: value.enabled,
      path: value.path,
      ...(typeof value.entryHash === "string" ? { entryHash: value.entryHash } : {}),
      ...(typeof value.manifestHash === "string" ? { manifestHash: value.manifestHash } : {}),
      ...(manifest ? { manifest } : {}),
    };
  }
  return normalized;
}

type RegistryWriter = (path: string, data: string) => void;
type RegistryReader = (path: string, encoding: "utf-8") => string;
type RegistryIdentity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type RegistryStat = (path: string) => RegistryIdentity;

function sameIdentity(left: RegistryIdentity, right: RegistryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readCommittedSnapshot(path: string, read: RegistryReader, stat: RegistryStat): { raw: string; identity: RegistryIdentity } {
  const before = stat(path);
  const raw = read(path, "utf-8");
  const after = stat(path);
  if (!sameIdentity(before, after) || Buffer.byteLength(raw, "utf-8") !== after.size) {
    throw new Error("Plugin registry snapshot changed during read");
  }
  return { raw, identity: after };
}

export function createPluginRegistryStore(
  path: string,
  writeAtomic: RegistryWriter = atomicWriteFileSync,
  readCommitted: RegistryReader = readFileSync,
  statCommitted: RegistryStat = statSync,
): PluginRegistryStore {
  return {
    read(): PluginRegistry {
      let first: { raw: string; identity: RegistryIdentity };
      try {
        first = readCommittedSnapshot(path, readCommitted, statCommitted);
      } catch (cause) {
        if (systemErrorCode(cause) === "ENOENT") return {};
        throw new PluginRegistryUnavailableError("read", cause);
      }
      try { return parseRegistry(first.raw); }
      catch (firstCause) {
        let second: { raw: string; identity: RegistryIdentity };
        try { second = readCommittedSnapshot(path, readCommitted, statCommitted); }
        catch (cause) { throw new PluginRegistryUnavailableError("read", cause); }
        if (first.raw !== second.raw || !sameIdentity(first.identity, second.identity)) {
          throw new PluginRegistryUnavailableError("read", firstCause);
        }
        try { parseRegistry(second.raw); }
        catch (secondCause) { throw new PluginRegistryContentError(secondCause); }
        throw new PluginRegistryUnavailableError("read", firstCause);
      }
    },
    write(registry: PluginRegistry): void {
      try {
        ensureDirFor(path);
        writeAtomic(path, JSON.stringify(registry, null, 2));
      } catch (cause) { throw new PluginRegistryUnavailableError("write", cause); }
    },
  };
}
