import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeConfig } from "../config.js";
import { configSchema } from "../config-schema.js";
import { killSwitchBlock } from "../tool-execution/kill-switch-gates.js";
import { projectedConfig } from "./container-runtime-projection.js";

// The container's config.json is written by projectedConfig(). It MUST carry
// the host's category kill-switches and local-only / supervised-browser toggles
// — otherwise getRuntimeConfig() inside the container falls back to schema
// defaults (every category ON, localOnly OFF, supervised OFF) and the
// pre-dispatch gates run tools the host disabled (e.g. bash while Shell is off).

const base = () => configSchema.parse({});

afterEach(() => setRuntimeConfig(base()));

describe("container projected config carries host security toggles", () => {
  it("projects the host kill-switch / local-only / supervised values", () => {
    setRuntimeConfig({
      ...base(),
      enableShell: false, enableHttp: false, enableBrowser: false,
      localOnlyMode: true, supervisedBrowser: true,
    });
    const projected = projectedConfig();
    expect(projected.enableShell).toBe(false);
    expect(projected.enableHttp).toBe(false);
    expect(projected.enableBrowser).toBe(false);
    expect(projected.localOnlyMode).toBe(true);
    expect(projected.supervisedBrowser).toBe(true);
    // A fresh per-container auth token, never the host's.
    expect(typeof projected.authToken).toBe("string");
    expect(projected.authToken).not.toBe(base().authToken);
  });

  it("makes the in-container kill-switch gate block a category the host disabled", () => {
    setRuntimeConfig({ ...base(), enableShell: false });
    // Parse the projection exactly as the container's getRuntimeConfig() would,
    // then run the gate the container's pre-dispatch runs.
    const containerCfg = configSchema.parse(projectedConfig());
    expect(containerCfg.enableShell).toBe(false);
    expect(killSwitchBlock("bash", containerCfg)?.field).toBe("enableShell");

    // With Shell enabled the same gate allows bash — guards against a gate that
    // can never pass, and proves the projection reflects the live host value.
    setRuntimeConfig({ ...base(), enableShell: true });
    expect(killSwitchBlock("bash", configSchema.parse(projectedConfig()))).toBeNull();
  });
});
