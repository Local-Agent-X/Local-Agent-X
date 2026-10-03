/**
 * The push review signs in with the token the user connected the GitHub
 * integration with: the vault entry the registry resolves from the user's own
 * setup, and nothing at all while the integration is not set up and switched
 * on. Any other GitHub-looking secret in the vault is not it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT: Record<string, string> = {};
vi.mock("../secrets.js", () => ({
  getSecretsStoreSingleton: () => ({ get: (name: string) => VAULT[name], has: (name: string) => name in VAULT }),
}));

import { githubIntegrationToken } from "./github-token.js";
import { IntegrationRegistry } from "../integrations/registry.js";

let dir = "";
const savedDataDir = process.env.LAX_DATA_DIR;
const registry = () => new IntegrationRegistry(dir, { has: (name) => name in VAULT });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-github-token-"));
  process.env.LAX_DATA_DIR = dir;
  for (const name of Object.keys(VAULT)) delete VAULT[name];
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = savedDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("githubIntegrationToken", () => {
  it("is the vault entry the user connected the GitHub integration with", () => {
    VAULT.GITHUB_TOKEN = "github_pat_connected";
    registry().markInstalled("github", true);
    expect(githubIntegrationToken()).toEqual({ name: "GITHUB_TOKEN", value: "github_pat_connected" });
  });

  it("follows the user's choice of vault entry, not another GitHub token in the vault", () => {
    VAULT.GITHUB_TOKEN = "github_pat_other";
    VAULT.TEAM_GITHUB_TOKEN = "github_pat_chosen";
    writeFileSync(join(dir, "integrations.json"), JSON.stringify([
      { id: "github", installed: true, enabled: true, credentials: [{ name: "TEAM_GITHUB_TOKEN" }] },
    ]));
    expect(githubIntegrationToken()).toEqual({ name: "TEAM_GITHUB_TOKEN", value: "github_pat_chosen" });
  });

  it("is nothing while the integration is not set up, is switched off, or its token is not in the vault", () => {
    VAULT.GITHUB_TOKEN = "github_pat_present";
    expect(githubIntegrationToken()).toBeNull();
    registry().markInstalled("github", true);
    registry().setEnabled("github", false);
    expect(githubIntegrationToken()).toBeNull();
    registry().setEnabled("github", true);
    delete VAULT.GITHUB_TOKEN;
    expect(githubIntegrationToken()).toBeNull();
  });
});
