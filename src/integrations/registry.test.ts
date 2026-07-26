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
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { SecretAvailabilityPort } from "../credentials/requirements.js";
import type { IntegrationConfig, IntegrationDeclaration, IntegrationEndpoint } from "./types.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-integrations-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const savedFile = () => join(dir, "integrations.json");
const write = (configs: unknown[]) => writeFileSync(savedFile(), JSON.stringify(configs, null, 2), "utf-8");

/** A vault holding exactly these names — anything else reads as never-set/deleted. */
const vault = (...names: string[]): SecretAvailabilityPort => ({ has: (name) => names.includes(name) });
/** Every credential present: the state the pre-gate build effectively assumed. */
const FULL_VAULT: SecretAvailabilityPort = { has: () => true };
const load = (secrets: SecretAvailabilityPort = FULL_VAULT) => new IntegrationRegistry(dir, secrets);

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

/**
 * The full context the PRE-gate build rendered for a lone installed GitHub,
 * pinned character-for-character. The gate may only REMOVE dishonest entries;
 * if it ever reformats, reorders or re-words an honest one this fails.
 */
const PRE_GATE_GITHUB_CONTEXT =
  "\n## Connected API Integrations\n" +
  "These APIs are configured and ready to use via the http_request tool.\n" +
  "Use the secret name as {{SECRET_NAME}} in Authorization headers.\n\n" +
  "### 🐙 GitHub (github)\n" +
  "Base URL: https://api.github.com\n" +
  "Auth: {{GITHUB_TOKEN}} as Bearer token\n" +
  'Extra headers: {"Accept":"application/vnd.github.v3+json"}\n' +
  "Endpoints:\n" +
  "- GET /user/repos — List your repositories\n" +
  "- POST /repos/{owner}/{repo}/issues — Create an issue\n" +
  "- GET /repos/{owner}/{repo}/pulls — List pull requests\n" +
  "- POST /repos/{owner}/{repo}/pulls — Create a pull request\n" +
  "- GET /user — Get authenticated user profile\n" +
  "- GET /notifications — List notifications\n\n";

/** A custom integration whose auth type and endpoint scopes the test picks. */
function custom(overrides: Partial<IntegrationDeclaration>): IntegrationDeclaration {
  return {
    id: "acme", name: "Acme", icon: "🔌", description: "", authType: "api_key",
    authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
    credentials: [{ name: "ACME_TOKEN" }],
    endpoints: [{ name: "Ping", method: "GET", path: "/ping", description: "ping" }],
    headers: {}, enabled: true, installed: true, builtin: false, ...overrides,
  };
}

describe("agent context credential gate", () => {
  it("renders an integration whose credentials are all present exactly as the pre-gate build did", () => {
    const registry = load(vault("GITHUB_TOKEN"));
    registry.markInstalled("github", true);

    expect(registry.getAgentContext()).toBe(PRE_GATE_GITHUB_CONTEXT);
  });

  it("drops an installed+enabled integration whose secret is not in the vault", () => {
    // Core new behaviour: the user deleted GITHUB_TOKEN but never uninstalled
    // GitHub. Every call would 401, so the model must not be told it can.
    const registry = load(vault("NOTION_API_KEY"));
    registry.markInstalled("github", true);
    registry.markInstalled("notion", true);

    const ctx = registry.getAgentContext();
    expect(ctx).not.toContain("(github)");
    expect(ctx).toContain("(notion)");
  });

  it("drops a multi-credential integration when only some of its credentials are present", () => {
    const registry = load(vault("ACME_TOKEN"));
    registry.addIntegration(custom({ credentials: [{ name: "ACME_TOKEN" }, { name: "ACME_SIGNING_KEY" }] }));

    expect(registry.getAgentContext()).toBe("");
  });

  it("advertises a multi-credential integration once every credential is present", () => {
    const registry = load(vault("ACME_TOKEN", "ACME_SIGNING_KEY"));
    registry.addIntegration(custom({ credentials: [{ name: "ACME_TOKEN" }, { name: "ACME_SIGNING_KEY" }] }));

    expect(registry.getAgentContext()).toContain("(acme)");
  });

  it("does not count a non-secret config requirement against the vault", () => {
    // `secret: false` means the value must NOT be encrypted at rest (SMTP_HOST
    // is the documented example), so its ABSENCE from the vault is the normal
    // state. Counting it would make any integration declaring a config value
    // permanently unadvertisable unless the user stuffed a hostname into the
    // vault. Only ACME_TOKEN is in this vault; ACME_HOST is deliberately not.
    const registry = load(vault("ACME_TOKEN"));
    registry.addIntegration(custom({ credentials: [{ name: "ACME_TOKEN" }, { name: "ACME_HOST", secret: false }] }));

    const ctx = registry.getAgentContext();
    expect(ctx).toContain("(acme)");
    // The gate ignores it; the RENDERING still teaches the model both names.
    expect(ctx).toContain("Auth: {{ACME_TOKEN}}, {{ACME_HOST}} as api_key");
  });

  it("still drops the integration when the secret half of a mixed list is missing", () => {
    const registry = load(vault("ACME_HOST"));
    registry.addIntegration(custom({ credentials: [{ name: "ACME_TOKEN" }, { name: "ACME_HOST", secret: false }] }));

    expect(registry.getAgentContext()).toBe("");
  });

  it("still short-circuits to nothing in local-only mode", () => {
    const saved = getRuntimeConfig();
    setRuntimeConfig({ ...saved, localOnlyMode: true });
    try {
      const registry = load(vault("GITHUB_TOKEN"));
      registry.markInstalled("github", true);
      expect(registry.getAgentContext()).toBe("");
    } finally {
      setRuntimeConfig(saved);
    }
  });
});

describe("agent context endpoint feasibility", () => {
  it("advertises only the google endpoints an api_key can actually reach", () => {
    const registry = load(vault("GOOGLE_API_KEY"));
    registry.markInstalled("google", true);

    const ctx = registry.getAgentContext();
    expect(ctx).toContain("/youtube/v3/search");
    for (const path of [
      "/gmail/v1/users/me/messages",
      "/gmail/v1/users/me/messages/send",
      "/calendar/v3/calendars/primary/events",
      "/drive/v3/files",
    ]) {
      expect(ctx, `${path} needs a user grant an api_key cannot produce`).not.toContain(path);
    }
  });

  it("advertises user-scoped endpoints to an oauth2 integration", () => {
    // The gate turns on auth type, not on the endpoint alone — otherwise the
    // annotation would just be a delete.
    const registry = load(vault("ACME_TOKEN"));
    registry.addIntegration(custom({
      authType: "oauth2",
      endpoints: [{ name: "Me", method: "GET", path: "/me", description: "my data", authScope: "user" }],
    }));

    expect(registry.getAgentContext()).toContain("- GET /me — my data");
  });

  it("does not advertise an integration whose every endpoint is out of reach", () => {
    const registry = load(vault("ACME_TOKEN"));
    registry.addIntegration(custom({
      endpoints: [{ name: "Me", method: "GET", path: "/me", description: "my data", authScope: "user" }],
    }));

    expect(registry.getAgentContext()).toBe("");
  });

  it("leaves email's smtp/imap pseudo-paths advertised — its transport is a separate concern", () => {
    // email declares no authScope and an empty baseUrl. The gate must neither
    // crash on that nor silently retire the integration.
    const registry = load(vault("SMTP_PASS"));
    registry.markInstalled("email", true);

    const ctx = registry.getAgentContext();
    expect(ctx).toContain("(email)");
    expect(ctx).toContain("- POST smtp — Send an email via SMTP");
  });

  it("drops email when the password lives under a vault name email.json redirects to", () => {
    // KNOWN, ACCEPTED, AND NOT FIXED HERE. email declares SMTP_PASS, but
    // src/tools/email-config.ts resolvePasswordSecretName() lets ~/.lax/email.json
    // point SMTP_PASS_SECRET at any vault entry (a user who saved theirs as
    // FASTMAIL), and env() also falls back to process.env.SMTP_PASS. Either user
    // has a working mailbox and no SMTP_PASS in the vault, so this gate hides
    // email from the agent context.
    //
    // Deliberately NOT special-cased here: importing email-config.ts would be a
    // cross-concern import into C7's file. What such a user loses is a context
    // block that is already nonsense — email's baseUrl is empty and its
    // endpoints are smtp/imap pseudo-paths, which is the baselined
    // `transport:email` finding. The real email path is the email_* tools
    // (email-send-tool.ts / email-read-tools.ts), which resolve credentials
    // through getSmtpConfig()/getImapConfig() and never read getAgentContext();
    // its only consumer is build-system-prompt.ts. So nothing functional breaks.
    // C7 is the fix: give email a truthful credential list and this follows.
    const registry = load(vault("FASTMAIL"));
    registry.markInstalled("email", true);

    expect(registry.getAgentContext()).toBe("");
  });
});

/**
 * canAuthTypeReach() makes a claim about ALL FOUR auth types, not one: only
 * oauth2 carries a user-context grant, so api_key, bearer_token AND bot_token
 * are alike app credentials that provably cannot reach an `authScope: "user"`
 * endpoint. Pinning a single app type would leave the other two free to drift —
 * `authType !== "api_key"`, `=== "oauth2" || === "bot_token"` and
 * `=== "oauth2" || === "bearer_token"` are all wrong and all passed the suite
 * when only the api_key leg was covered.
 *
 * Latent today, since no builtin annotates authScope on a bearer_token or
 * bot_token integration — but slack (bot_token) and twitter/facebook/ebay/
 * spotify/instagram (bearer_token) are each ONE annotation away, and the field
 * exists precisely so they can opt in.
 *
 * Each case declares an app-reachable endpoint alongside the user-scoped one so
 * the integration is advertised either way: the assertion is about which
 * ENDPOINTS survive, independent of the nothing-reachable drop rule, which the
 * last case then pins separately.
 */
const AUTH_TYPES = ["api_key", "bearer_token", "bot_token", "oauth2"] as const;
/** The one auth type that carries a user-context grant. */
const USER_GRANT_AUTH_TYPE = "oauth2";

const UNSCOPED_ENDPOINT: IntegrationEndpoint =
  { name: "Ping", method: "GET", path: "/ping", description: "ping" };
const APP_SCOPED_ENDPOINT: IntegrationEndpoint =
  { name: "Stats", method: "GET", path: "/stats", description: "stats", authScope: "app" };
const USER_SCOPED_ENDPOINT: IntegrationEndpoint =
  { name: "Me", method: "GET", path: "/me", description: "my data", authScope: "user" };

describe.each(AUTH_TYPES)("agent context endpoint feasibility for %s auth", (authType) => {
  const carriesUserGrant = authType === USER_GRANT_AUTH_TYPE;

  function contextFor(endpoints: IntegrationEndpoint[]): string {
    const registry = load(vault("ACME_TOKEN"));
    registry.addIntegration(custom({ authType, endpoints }));
    return registry.getAgentContext();
  }

  it("reaches an endpoint that declares no scope and one that declares app scope", () => {
    const ctx = contextFor([UNSCOPED_ENDPOINT, APP_SCOPED_ENDPOINT, USER_SCOPED_ENDPOINT]);
    expect(ctx).toContain("- GET /ping — ping");
    expect(ctx).toContain("- GET /stats — stats");
  });

  it(`${carriesUserGrant ? "reaches" : "cannot reach"} a user-scoped endpoint`, () => {
    const ctx = contextFor([UNSCOPED_ENDPOINT, USER_SCOPED_ENDPOINT]);
    expect(ctx).toContain("(acme)");
    expect(ctx.includes("- GET /me — my data")).toBe(carriesUserGrant);
  });

  it(`${carriesUserGrant ? "advertises" : "drops"} an integration whose only endpoint is user-scoped`, () => {
    expect(contextFor([USER_SCOPED_ENDPOINT]).includes("(acme)")).toBe(carriesUserGrant);
  });
});

/**
 * The body POST /api/integrations receives from the Settings "add custom
 * integration" form, verbatim: public/js/settings-integrations.js
 * addCustomIntegration() plus the defaults the route applies
 * (src/routes/bridges/integrations.ts — builtin/installed/enabled, and
 * `if (!body.endpoints) body.endpoints = []`). The form has NO endpoints input,
 * so ZERO endpoints is the only shape the product's UI can produce. Tests that
 * reach for `custom()` get an endpoint the real feature never has.
 */
function asTheFormPosts(overrides: Record<string, unknown> = {}): IntegrationDeclaration {
  return {
    id: "acme", name: "Acme", description: "Acme API", icon: "🔌",
    authType: "bearer_token", authInstructions: "Add your API key for Acme",
    baseUrl: "https://api.acme.test", docsUrl: "",
    secretName: "ACME_API_KEY",
    endpoints: [], headers: {},
    builtin: false, installed: false, enabled: true,
    ...overrides,
  } as unknown as IntegrationDeclaration;
}

describe("agent context for a custom integration that declares no endpoints", () => {
  it("advertises it — the heading is the payload http_request needs", () => {
    // A user adds a custom API in Settings, saves the key, and sees it listed
    // as installed. Dropping it for having no endpoints would delete the entire
    // "add custom integration" feature from the agent's context, because the
    // form cannot produce any other shape.
    const registry = load(vault("ACME_API_KEY"));
    registry.addIntegration(asTheFormPosts());
    registry.markInstalled("acme", true);

    expect(registry.getAgentContext()).toBe(
      "\n## Connected API Integrations\n" +
      "These APIs are configured and ready to use via the http_request tool.\n" +
      "Use the secret name as {{SECRET_NAME}} in Authorization headers.\n\n" +
      "### 🔌 Acme (acme)\n" +
      "Base URL: https://api.acme.test\n" +
      "Auth: {{ACME_API_KEY}} as Bearer token\n" +
      "Endpoints:\n\n",
    );
  });

  it("carries its extra headers through", () => {
    const registry = load(vault("ACME_API_KEY"));
    registry.addIntegration(asTheFormPosts({ headers: { "X-Acme-Version": "2" } }));
    registry.markInstalled("acme", true);

    expect(registry.getAgentContext()).toContain('Extra headers: {"X-Acme-Version":"2"}\n');
  });

  it("still gates it on the vault holding its secret", () => {
    const registry = load(vault("SOMETHING_ELSE"));
    registry.addIntegration(asTheFormPosts());
    registry.markInstalled("acme", true);

    expect(registry.getAgentContext()).toBe("");
  });
});

/**
 * `endpoints` is REQUIRED by IntegrationDeclaration, but the persisted
 * integrations.json is plain JSON that nothing type-checks on the way in: a
 * hand-edited file, or one written before the field existed, can simply not
 * have it. Reading it unguarded threw
 * `TypeError: Cannot read properties of undefined (reading 'filter')` out of
 * getAgentContext() — whose only caller is build-system-prompt.ts:88 — so a
 * single malformed saved entry killed EVERY request, not just that integration.
 *
 * The fix normalises at the one funnel every config enters through, so `list()`,
 * `get()` and the routes reading them are covered by the same change rather
 * than each read needing its own guard.
 */
describe("a config that omits the endpoints field entirely", () => {
  const noEndpointsField = {
    id: "acme", name: "Acme", icon: "🔌", description: "Acme API", authType: "api_key" as const,
    authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
    secretName: "ACME_TOKEN", headers: {}, enabled: true, installed: true, builtin: false,
  };

  it("loads from integrations.json as zero endpoints instead of throwing", () => {
    write([noEndpointsField]);

    const registry = load(vault("ACME_TOKEN"));
    expect(registry.get("acme")!.endpoints).toEqual([]);
    expect(registry.list().every((i) => Array.isArray(i.endpoints))).toBe(true);
  });

  it("still renders the agent context rather than killing the whole request", () => {
    write([noEndpointsField]);

    const ctx = load(vault("ACME_TOKEN")).getAgentContext();
    expect(ctx).toContain("### 🔌 Acme (acme)");
    expect(ctx).toContain("Base URL: https://api.acme.test");
  });

  it("normalises the same way when the config arrives through addIntegration", () => {
    // The double cast is the POINT, not a shortcut: `endpoints` is required by
    // IntegrationDeclaration, so this shape can only arrive from something the
    // compiler never saw — parsed JSON, or a JS caller. Same reason
    // asTheFormPosts() above casts.
    const registry = load(vault("ACME_TOKEN"));
    registry.addIntegration(
      { ...noEndpointsField, credentials: [{ name: "ACME_TOKEN" }] } as unknown as IntegrationDeclaration,
    );

    expect(registry.get("acme")!.endpoints).toEqual([]);
    expect(registry.getAgentContext()).toContain("(acme)");
  });

  it("survives a round trip through the file it writes", () => {
    write([noEndpointsField]);
    load(vault("ACME_TOKEN")).markInstalled("acme", true);

    const saved = JSON.parse(readFileSync(savedFile(), "utf-8")) as IntegrationConfig[];
    expect(saved.find((s) => s.id === "acme")!.endpoints).toEqual([]);
    expect(load(vault("ACME_TOKEN")).getAgentContext()).toContain("(acme)");
  });
});

describe("agent context install/enable gate", () => {
  it("does not advertise an installed integration the user disabled", () => {
    const registry = load(FULL_VAULT);
    registry.markInstalled("github", true);
    registry.setEnabled("github", false);

    expect(registry.getAgentContext()).toBe("");
  });

  it("does not advertise an enabled-by-default integration that was never installed", () => {
    // Every builtin ships enabled:true, installed:false — so "enabled" alone
    // must never be enough, or a fresh profile advertises the whole catalogue.
    const registry = load(FULL_VAULT);

    expect(registry.getAgentContext()).toBe("");
  });

  it("renders exactly the one installed integration even when the vault holds everything", () => {
    // Byte-identity with a vault that can never mask an over-broad gate: if the
    // install/enable filter widens, the other ten builtins show up here.
    const registry = load(FULL_VAULT);
    registry.markInstalled("github", true);

    expect(registry.getAgentContext()).toBe(PRE_GATE_GITHUB_CONTEXT);
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
