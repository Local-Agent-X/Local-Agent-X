import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { readOp, withOpLock, writeOp } from "../ops/op-store.js";
import { createRuntimeReconstructionFailureAdapter } from "./adapters/runtime-reconstruction-failure.js";
import { createProviderAdapterFactory, RuntimeIdentityMismatchError } from "./provider-adapter-factory.js";
import { RuntimeSurfaceMismatchError } from "./agent-runner/runtime-surface-error.js";
import { isRuntimeFailoverBoundary } from "../ops/target-identity.js";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CredentialResolution } from "../auth/auth-provider.js";
import { verifyDurableRecordMac } from "../app-runtime/audit-signing.js";

const PROJECTED_CREDENTIAL_DOMAIN = "canonical-container-credential-v1";

export function createRecoveredAdapterFactory(
  op: Op,
  descriptor: ExactDelegatedRuntimeDescriptor,
  cleanupSurface: () => void,
) {
  return async () => {
    try {
      const { getRuntimeConfig } = await import("../config.js");
      const { getSetting } = await import("../settings.js");
      const resolution = await resolveRecoveryCredential(descriptor);
      if (!resolution) throw new Error("credential unavailable");
      if (isRuntimeFailoverBoundary(op, descriptor)) {
        const { validatePersistedFailoverTarget } = await import("./runtime-failover.js");
        if (!validatePersistedFailoverTarget(op, descriptor)) {
          throw new Error("persisted failover target is no longer eligible");
        }
      }
      let systemPrompt: string | undefined;
      if (descriptor.surface) {
        const { rehydrateAgentRuntimeSurface } = await import("./agent-runner/runtime-surface.js");
        systemPrompt = rehydrateAgentRuntimeSurface(op, descriptor.surface);
      }
      const factory = await createProviderAdapterFactory(descriptor, {
        apiKey: resolution.credential,
        authSource: resolution.source,
        customBaseURL: getSetting<string>("customBaseUrl"),
        sessionId: descriptor.sessionId,
        systemPrompt,
        requireToolOnFirstTurn: descriptor.surface?.kind === "agent-runner",
      });
      const adapter = await factory();
      updateRecoveryState(op, fresh => {
        if (fresh.canonical) fresh.canonical.retryNotBefore = null;
        if (fresh.lastFailureReason?.startsWith("adapter_retry:")) fresh.lastFailureReason = undefined;
      });
      return adapter;
    } catch (error) {
      cleanupSurface();
      const terminalCode = terminalRuntimeReconstructionCode(error);
      if (terminalCode) {
        markRuntimeReconstructionTerminal(op, terminalCode);
        return createRuntimeReconstructionFailureAdapter(false);
      }
      return createRuntimeReconstructionFailureAdapter(true);
    }
  };
}

async function resolveRecoveryCredential(
  descriptor: ExactDelegatedRuntimeDescriptor,
): Promise<CredentialResolution | null> {
  const projected = process.env.LAX_SCOPED_RUNTIME_CREDENTIAL_FILE;
  if (projected) return readProjectedCredential(projected, descriptor);
  const { resolveCredential } = await import("../auth/resolve.js");
  const { getRuntimeConfig } = await import("../config.js");
  return resolveCredential(descriptor.credentialProvider, {
    requiredSource: descriptor.authSource,
    configOpenAIKey: descriptor.credentialProvider === "openai" ? getRuntimeConfig().openaiApiKey : undefined,
  });
}

export function readProjectedCredential(
  path: string,
  descriptor: ExactDelegatedRuntimeDescriptor,
): CredentialResolution {
  if (!isAbsolute(path)) throw new Error("projected credential path must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("projected credential must be a bounded regular file");
  }
  const sealed = JSON.parse(readFileSync(path, "utf8")) as {
    credential?: Partial<CredentialResolution>;
    mac?: unknown;
  };
  const value = sealed.credential;
  if (!value || value.provider !== descriptor.credentialProvider || value.source !== descriptor.authSource
    || typeof value.credential !== "string" || !value.credential
    || typeof sealed.mac !== "string"
    || !verifyDurableRecordMac(PROJECTED_CREDENTIAL_DOMAIN, JSON.stringify(value), sealed.mac)) {
    throw new Error("projected credential identity mismatch");
  }
  return value as CredentialResolution;
}

export function terminalRuntimeReconstructionCode(
  error: unknown,
): string | null {
  if (error instanceof RuntimeSurfaceMismatchError) return `surface_${safeCode(error.code)}`;
  if (error instanceof RuntimeIdentityMismatchError) return `identity_${safeCode(error.code)}`;
  return null;
}

export function markRuntimeReconstructionTerminal(op: Op, code: string): void {
  updateRecoveryState(op, fresh => {
    if (fresh.canonical) fresh.canonical.retryNotBefore = null;
    fresh.lastFailureReason = `runtime_reconstruction:${safeCode(code)}`;
    fresh.lastFailureAt = new Date().toISOString();
  });
}

function updateRecoveryState(op: Op, update: (fresh: Op) => void): void {
  withOpLock(op.id, () => {
    const fresh = readOp(op.id) ?? op;
    update(fresh);
    writeOp(fresh);
    Object.assign(op, fresh);
  });
}

function safeCode(code: string): string {
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code.toLowerCase() : "unavailable";
}
