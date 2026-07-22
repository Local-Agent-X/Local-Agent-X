import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _resetAuditKeyCacheForTests, computeDurableRecordMac } from "../app-runtime/audit-signing.js";
import { RuntimeSurfaceMismatchError } from "./agent-runner/runtime-surface-error.js";
import { RuntimeIdentityMismatchError } from "./provider-adapter-factory.js";
import { readProjectedCredential, terminalRuntimeReconstructionCode } from "./runtime-reconstruction.js";

const priorAuditKey = process.env.LAX_AUDIT_KEY;
let projectedDir: string | null = null;
afterEach(() => {
  if (projectedDir) rmSync(projectedDir, { recursive: true, force: true });
  projectedDir = null;
  if (priorAuditKey === undefined) delete process.env.LAX_AUDIT_KEY;
  else process.env.LAX_AUDIT_KEY = priorAuditKey;
  _resetAuditKeyCacheForTests();
});

describe("runtime reconstruction failure classification", () => {
  it("accepts only the MAC-sealed credential for the exact descriptor source", () => {
    process.env.LAX_AUDIT_KEY = "projected-credential-test";
    _resetAuditKeyCacheForTests();
    projectedDir = mkdtempSync(join(tmpdir(), "lax-projected-credential-"));
    const path = join(projectedDir, "credential.json");
    const credential = { provider: "openai" as const, credential: "scoped", source: "env" as const };
    writeFileSync(path, JSON.stringify({ credential,
      mac: computeDurableRecordMac("canonical-container-credential-v1", JSON.stringify(credential)) }));
    const descriptor = { credentialProvider: "openai", authSource: "env" } as never;
    expect(readProjectedCredential(path, descriptor)).toEqual(credential);
    writeFileSync(path, JSON.stringify({ credential: { ...credential, credential: "changed" },
      mac: "0".repeat(64) }));
    expect(() => readProjectedCredential(path, descriptor)).toThrow("identity mismatch");
  });
  it("terminalizes deterministic identity and policy mismatches immediately", () => {
    expect(terminalRuntimeReconstructionCode(
      new RuntimeSurfaceMismatchError("tool_identity_changed"),
    )).toBe("surface_tool_identity_changed");
    expect(terminalRuntimeReconstructionCode(
      new RuntimeIdentityMismatchError("endpoint_fingerprint_changed"),
    )).toBe("identity_endpoint_fingerprint_changed");
  });

  it("leaves credential and runtime availability failures retryable", () => {
    expect(terminalRuntimeReconstructionCode(
      new Error("credential temporarily unavailable marker-secret-123"),
    )).toBeNull();
  });
});
