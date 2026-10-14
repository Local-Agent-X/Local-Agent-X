import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { Op } from "../ops/types.js";
import { bindDelegatedSessionLineage, releaseDelegatedSessionLineage } from "./delegated-session-lineage.js";
import { _resetSessionOwnerRegistry, resolveBrowserSessionId } from "../browser/session-owner-registry.js";
import { clearSessionTaint, getTaintSummary, recordSensitiveRead } from "../data-lineage/index.js";
import { clearExternalIngestion, hasExternalIngestion, recordExternalIngestion } from "../data-lineage/external.js";
import { clearTaskArtifacts, listTaskArtifacts, recordTaskArtifact } from "../data-lineage/task-artifacts.js";

const WORKER = "op_lineage_worker";
const PARENT = "chat-lineage-parent";

function workerOp(parentSessionId?: string): Op {
  return {
    id: WORKER,
    runtimeDescriptor: {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider: "openai",
      credentialProvider: "openai",
      authSource: "config",
      model: "m",
      runtime: "openai-compat",
      target: { kind: "provider-registry", endpointFingerprint: "f" },
      sessionId: WORKER,
      ...(parentSessionId ? { parentSessionId } : {}),
      integrity: { scheme: "hmac-sha256-v1", mac: "m" },
    },
  } as unknown as Op;
}

afterEach(() => {
  _resetSessionOwnerRegistry();
  for (const id of [WORKER, PARENT]) {
    clearSessionTaint(id);
    clearExternalIngestion(id);
    clearTaskArtifacts(id);
  }
});

describe("delegated session lineage", () => {
  it("bind: the worker drives its parent chat's browser; without a parent it drives its own", () => {
    bindDelegatedSessionLineage(WORKER, PARENT);
    expect(resolveBrowserSessionId(WORKER)).toBe(PARENT);
    _resetSessionOwnerRegistry();
    bindDelegatedSessionLineage(WORKER, undefined);
    expect(resolveBrowserSessionId(WORKER)).toBe(WORKER);
  });

  it("release: what the worker read, ingested and created follows its result into the parent, and the owner record is dropped", () => {
    bindDelegatedSessionLineage(WORKER, PARENT);
    recordSensitiveRead(WORKER, "sensitive_file", "~/.ssh/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY----- ".repeat(8));
    recordExternalIngestion(WORKER, "an untrusted page the worker fetched, with enough words to fingerprint ".repeat(6), "web");
    const artifact = resolve("ws", "apps", "proj", "index.html");
    recordTaskArtifact(WORKER, artifact);
    expect(hasExternalIngestion(PARENT)).toBe(false);

    releaseDelegatedSessionLineage(workerOp(PARENT));

    expect(getTaintSummary(PARENT).count).toBe(1);
    expect(hasExternalIngestion(PARENT)).toBe(true);
    expect(listTaskArtifacts(PARENT)).toEqual([artifact]);
    expect(resolveBrowserSessionId(WORKER)).toBe(WORKER);
  });

  it("release: a no-op for an op without a parent, and for non-delegated shapes", () => {
    recordExternalIngestion(WORKER, undefined, "web");
    releaseDelegatedSessionLineage(workerOp(undefined));
    releaseDelegatedSessionLineage({ id: "op_chat", runtimeDescriptor: undefined } as unknown as Op);
    expect(hasExternalIngestion(PARENT)).toBe(false);
  });
});
