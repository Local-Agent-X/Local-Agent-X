import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityLayer } from "./layer-core.js";
import { fingerprintSecurityPolicy, type CategoryPolicyFingerprintInput } from "./runtime-state.js";
import { setRuntimeConfig } from "../../config.js";
import { configSchema } from "../../config-schema.js";

// The category kill-switches (enableShell/enableHttp/enableBrowser) plus the
// local-only and supervised-browser toggles are security policy the container's
// pre-dispatch gates enforce. They must be part of the SEALED policy fingerprint
// so a container that reads different toggles (schema-default fallback, or a
// tampered projected config.json) recomputes a DIFFERENT fingerprint than the
// host sealed into the runtime surface — making rehydrateAgentRuntimeSurface
// fail CLOSED, exactly like the egress-field divergence it already guards.

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "security-killswitch-"));
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  setRuntimeConfig(configSchema.parse({}));
});

const ALL_ON: CategoryPolicyFingerprintInput = {
  enableShell: true, enableHttp: true, enableBrowser: true,
  localOnlyMode: false, supervisedBrowser: false,
};

const fp = (cat: CategoryPolicyFingerprintInput): string =>
  fingerprintSecurityPolicy("common", "refuse", "permissive", false, [], [], "7007", cat);

describe("SecurityLayer policy fingerprint — category kill-switches", () => {
  it("folds every category toggle into the sealed fingerprint", () => {
    const baseline = fp(ALL_ON);
    const divergent: CategoryPolicyFingerprintInput[] = [
      { ...ALL_ON, enableShell: false },
      { ...ALL_ON, enableHttp: false },
      { ...ALL_ON, enableBrowser: false },
      { ...ALL_ON, localOnlyMode: true },
      { ...ALL_ON, supervisedBrowser: true },
    ];
    for (const cat of divergent) expect(fp(cat)).not.toBe(baseline);
    // Same toggles → identical hash (not a can't-fail test: equality still holds).
    expect(fp({ ...ALL_ON })).toBe(baseline);
  });

  it("recomputes a different runtimePolicyFingerprint when the host disables Shell", () => {
    setRuntimeConfig({ ...configSchema.parse({}), enableShell: true });
    const hostSealed = new SecurityLayer(dataDir, "common").runtimePolicyFingerprint();
    // Host had Shell OFF but the container fell back to schema-default-ON (or a
    // tampered config re-enabled it): the recomputed fingerprint diverges, so
    // rehydrateAgentRuntimeSurface rejects the surface (security_policy_changed).
    setRuntimeConfig({ ...configSchema.parse({}), enableShell: false });
    const recomputed = new SecurityLayer(dataDir, "common").runtimePolicyFingerprint();
    expect(recomputed).not.toBe(hostSealed);
  });
});
