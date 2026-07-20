import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFileSync, writeFileSync } = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({ readFileSync, writeFileSync }));
vi.mock("./scanners.js", () => ({
  scanPages: () => [],
  scanSettingsTabs: () => [],
  scanAgentTabs: () => [],
  scanTools: () => [],
  scanApps: () => [],
  scanConfigFiles: () => [],
}));
vi.mock("./route-scanner.js", () => ({ scanApiRoutes: () => [] }));

import { generateManifest, writeManifest } from "./generator.js";

describe("writeManifest", () => {
  beforeEach(() => {
    readFileSync.mockReset();
    writeFileSync.mockReset();
  });

  it("does not rewrite an unchanged manifest just to refresh generatedAt", () => {
    const existing = { ...generateManifest(), generatedAt: "earlier" };
    readFileSync.mockReturnValue(JSON.stringify(existing));

    writeManifest();

    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("publishes a manifest when its structural content changes", () => {
    const existing = { ...generateManifest(), bridges: [] };
    readFileSync.mockReturnValue(JSON.stringify(existing));

    writeManifest();

    expect(writeFileSync).toHaveBeenCalledOnce();
  });

  it("replaces a malformed manifest", () => {
    readFileSync.mockReturnValue("not-json");

    writeManifest();

    expect(writeFileSync).toHaveBeenCalledOnce();
  });
});
