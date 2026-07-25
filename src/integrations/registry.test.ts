/**
 * Integration credential-list migration + back-compat.
 *
 * `IntegrationConfig` used to carry a single `secretName`. It now carries a
 * `credentials` LIST typed with the shared CredentialRequirement, because real
 * integrations need more than one value. Two things must hold forever:
 *
 *  - users have a ~/.lax/integrations.json written by the PRE-list build, and
 *    setting `secretName` there was a real feature — it points an integration
 *    at a different vault entry than the builtin default. That override has to
 *    keep working, or a user silently loses their credential wiring on upgrade.
 *  - the install/uninstall/test route and the Settings modal each handle
 *    exactly ONE vault entry and still read `config.secretName`. It is now a
 *    derived view of the primary credential and must never drift from the list.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationRegistry } from "./registry.js";
import { BUILTIN_INTEGRATIONS } from "./builtins/index.js";
import type { IntegrationConfig, IntegrationDeclaration } from "./types.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-integrations-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const savedFile = () => join(dir, "integrations.json");
const write = (configs: unknown[]) => writeFileSync(savedFile(), JSON.stringify(configs, null, 2), "utf-8");
const load = () => new IntegrationRegistry(dir);

/** A config exactly as the pre-list build wrote it: one `secretName`, no list. */
function preListConfig(id: string, secretName: string, extra: Record<string, unknown> = {}) {
  return { id, installed: true, enabled: true, secretName, ...extra };
}

describe("integration credential declarations", () => {
  it("gives every builtin at least one credential", () => {
    for (const declaration of BUILTIN_INTEGRATIONS) {
      expect(declaration.credentials.length, `${declaration.id} declares no credential`).toBeGreaterThan(0);
      for (const credential of declaration.credentials) {
        expect(credential.name, `${declaration.id} credential name`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it("derives secretName from the primary credential for every builtin", () => {
    const registry = load();
    for (const declaration of BUILTIN_INTEGRATIONS) {
      const config = registry.get(declaration.id)!;
      expect(config.secretName).toBe(declaration.credentials[0].name);
    }
  });

  it("does not mutate the builtin declarations when a saved file overrides them", () => {
    write([preListConfig("github", "MY_OTHER_GITHUB_TOKEN")]);
    load();
    const github = BUILTIN_INTEGRATIONS.find((i) => i.id === "github")!;
    expect(github.credentials.map((c) => c.name)).toEqual(["GITHUB_TOKEN"]);
  });
});

describe("loading a pre-list integrations.json", () => {
  it("keeps a saved secretName pointing the integration at a different vault entry", () => {
    write([preListConfig("github", "MY_OTHER_GITHUB_TOKEN")]);

    const config = load().get("github")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["MY_OTHER_GITHUB_TOKEN"]);
    // The single-name readers (install route, Settings modal) must see it too.
    expect(config.secretName).toBe("MY_OTHER_GITHUB_TOKEN");
  });

  it("still adopts the saved installed/enabled state", () => {
    write([preListConfig("slack", "SLACK_BOT_TOKEN", { installed: true, enabled: false })]);

    const config = load().get("slack")!;
    expect(config.installed).toBe(true);
    expect(config.enabled).toBe(false);
  });

  it("keeps the builtin default when the saved config overrides nothing", () => {
    write([{ id: "notion", installed: true, enabled: true }]);

    const config = load().get("notion")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["NOTION_API_KEY"]);
    expect(config.secretName).toBe("NOTION_API_KEY");
    expect(config.installed).toBe(true);
  });

  it("adopts a pre-list custom integration by deriving its list", () => {
    write([preListConfig("acme", "ACME_TOKEN", {
      name: "Acme", baseUrl: "https://api.acme.test", endpoints: [], builtin: false,
    })]);

    const config = load().get("acme")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["ACME_TOKEN"]);
    expect(config.secretName).toBe("ACME_TOKEN");
  });

  it("renames only the primary and keeps every other credential the builtin declares", () => {
    // A pre-list file can only ever name ONE credential, so the override has to
    // be a rename of the primary — not a truncation of the builtin's list. This
    // sweeps every builtin so it grows teeth the moment one declares more than
    // one credential (every builtin declares exactly one today).
    write(BUILTIN_INTEGRATIONS.map((i) => preListConfig(i.id, `MY_${i.credentials[0].name}`)));

    const registry = load();
    for (const declaration of BUILTIN_INTEGRATIONS) {
      const config = registry.get(declaration.id)!;
      expect(config.credentials.map((c) => c.name), declaration.id).toEqual([
        `MY_${declaration.credentials[0].name}`,
        ...declaration.credentials.slice(1).map((c) => c.name),
      ]);
      // Non-name metadata of the renamed primary survives — only the vault
      // entry it points at changed.
      expect(config.credentials[0].description).toBe(declaration.credentials[0].description);
    }
  });
});

describe("loading a post-list integrations.json", () => {
  it("lets the saved credential list override the builtin default", () => {
    write([{ id: "github", installed: true, enabled: true, credentials: [{ name: "TEAM_GITHUB_TOKEN" }] }]);

    const config = load().get("github")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["TEAM_GITHUB_TOKEN"]);
    expect(config.secretName).toBe("TEAM_GITHUB_TOKEN");
  });

  it("prefers the list over the derived secretName the registry also writes", () => {
    // Saved files carry BOTH: the list plus the derived single name. If the two
    // ever disagree the list is the source of truth.
    write([{
      id: "github", installed: true, enabled: true,
      credentials: [{ name: "TEAM_GITHUB_TOKEN" }], secretName: "STALE_GITHUB_TOKEN",
    }]);

    expect(load().get("github")!.secretName).toBe("TEAM_GITHUB_TOKEN");
  });

  it("ignores a partially malformed list instead of promoting a different credential", () => {
    write([{ id: "github", installed: true, enabled: true, credentials: [{ nome: "TYPO" }, { name: "REAL_TOKEN" }] }]);

    const config = load().get("github")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["GITHUB_TOKEN"]);
    expect(config.secretName).toBe("GITHUB_TOKEN");
  });

  it("round-trips what it saved", () => {
    write([preListConfig("github", "MY_OTHER_GITHUB_TOKEN")]);
    load().markInstalled("github", true); // forces a save in the new shape

    const config = load().get("github")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["MY_OTHER_GITHUB_TOKEN"]);
    expect(config.secretName).toBe("MY_OTHER_GITHUB_TOKEN");
  });

  it("writes the derived secretName so a pre-list build can still read the file", () => {
    load().markInstalled("github", true);

    const saved = JSON.parse(readFileSync(savedFile(), "utf-8")) as IntegrationConfig[];
    const github = saved.find((s) => s.id === "github")!;
    expect(github.secretName).toBe("GITHUB_TOKEN");
  });
});

describe("adding an integration", () => {
  const base = {
    id: "acme", name: "Acme", icon: "🔌", description: "", authType: "api_key" as const,
    authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
    endpoints: [], headers: {}, enabled: true, installed: false, builtin: false,
  };

  it("normalizes a pre-list body from POST /api/integrations", () => {
    // The Settings "add custom integration" form still posts a bare secretName.
    const registry = load();
    registry.addIntegration({ ...base, secretName: "ACME_TOKEN" } as unknown as IntegrationDeclaration);

    const config = registry.get("acme")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["ACME_TOKEN"]);
    expect(config.secretName).toBe("ACME_TOKEN");
  });

  it("accepts a credential list and derives the primary from it", () => {
    const registry = load();
    registry.addIntegration({ ...base, credentials: [{ name: "ACME_TOKEN" }, { name: "ACME_HOST", secret: false }] });

    const config = registry.get("acme")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["ACME_TOKEN", "ACME_HOST"]);
    expect(config.secretName).toBe("ACME_TOKEN");
  });

  it("still refuses a base URL the egress policy rejects", () => {
    expect(() => load().addIntegration({
      ...base, baseUrl: "http://169.254.169.254/latest/meta-data", credentials: [{ name: "ACME_TOKEN" }],
    })).toThrow(/SSRF/);
  });
});

describe("agent context", () => {
  it("advertises every declared credential", () => {
    const registry = load();
    registry.addIntegration({
      id: "acme", name: "Acme", icon: "🔌", description: "", authType: "bearer_token",
      authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
      credentials: [{ name: "ACME_TOKEN" }, { name: "ACME_HOST", secret: false }],
      endpoints: [{ name: "Ping", method: "GET", path: "/ping", description: "ping" }],
      headers: {}, enabled: true, installed: true, builtin: false,
    });

    expect(registry.getAgentContext()).toContain("Auth: {{ACME_TOKEN}}, {{ACME_HOST}} as Bearer token");
  });

  it("renders a single-credential integration exactly as the pre-list build did", () => {
    const registry = load();
    registry.markInstalled("github", true);

    expect(registry.getAgentContext()).toContain("Auth: {{GITHUB_TOKEN}} as Bearer token");
  });
});

describe("authoring schema", () => {
  it("teaches the credential list, not the retired single name", () => {
    const schema = JSON.parse(IntegrationRegistry.getIntegrationSchema());
    expect(schema.secretName).toBeUndefined();
    expect(Array.isArray(schema.credentials)).toBe(true);
    expect(schema.credentials[0].name).toBe("SERVICE_API_KEY");
  });
});
