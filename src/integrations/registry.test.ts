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
import { isRequiredRequirement, isSecretRequirement, type SecretAvailabilityPort } from "../credentials/requirements.js";
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

/**
 * BUILTIN_INTEGRATIONS is module-level state shared by every registry in the
 * process (the server holds one; every test here builds more), and a registry
 * hands its configs straight out through get()/list(). If a config's credential
 * OBJECTS are the builtin's own, a per-registry write goes through into the
 * shared declaration and every other registry — every other user of the process
 * — sees it.
 *
 * Two sites shared them, and both were harmless only while every builtin
 * declared exactly ONE credential: withDerivedSecretName() passed the builtin's
 * own array straight through, and the rename branch cloned the primary and
 * spread `...rest` by reference. email declaring nine is what makes them live.
 *
 * The first case kills the funnel (withDerivedSecretName) on its own. The second
 * goes through withPrimaryRenamed() as well, and kills the pair: with the funnel
 * clone gone it is the only thing standing between the builtin's own objects and
 * a caller's write.
 *
 * Each case mutates a NON-primary entry, because the primary is the one entry
 * the rename branch already copied — asserting on it would pass against the bug.
 */
describe("credential objects are private to each registry", () => {
  /** The builtin with more than one credential; a one-credential builtin has no non-primary to mutate. */
  const multiCredentialBuiltin = () => {
    const declaration = BUILTIN_INTEGRATIONS.find((i) => i.id === "email")!;
    expect(declaration.credentials.length, "email must declare more than one credential").toBeGreaterThan(1);
    return declaration;
  };

  /** Mutates through `first`, asserts `second` and the builtin are untouched, then restores. */
  function expectIsolated(first: IntegrationRegistry, second: IntegrationRegistry) {
    const declaration = multiCredentialBuiltin();
    const shared = declaration.credentials[1];
    const original = { ...shared };
    try {
      first.get("email")!.credentials[1].name = "LEAKED_THROUGH_THE_BUILTIN";

      expect(second.get("email")!.credentials[1].name).toBe(original.name);
      expect(declaration.credentials[1].name).toBe(original.name);
    } finally {
      // A failure here means the write DID land on the shared declaration; put
      // it back so one red test cannot cascade into every later one.
      Object.assign(shared, original);
    }
  }

  it("does not share them between registries loaded from the builtins", () => {
    expectIsolated(load(), load());
  });

  it("does not share them when a saved file renames the primary", () => {
    // The legacy-secretName branch: it rebuilds the list around a renamed
    // primary, and the entries after it are what leaked.
    write([preListConfig("email", "MY_SMTP_PASS")]);

    expectIsolated(load(), load());
  });
});

/**
 * email is the integration the credential LIST exists for. Its authInstructions
 * have always asked the user for nine values while the declaration named one,
 * so eight of them had no declared home: the install path could not store them,
 * and the only working config route was the email_setup tool. Declaring them is
 * what lets Settings act on them at all.
 */
describe("email's declared credential set", () => {
  const email = () => BUILTIN_INTEGRATIONS.find((i) => i.id === "email")!;

  it("declares every value its authInstructions ask for, SMTP_PASS first", () => {
    expect(email().credentials.map((c) => c.name)).toEqual([
      "SMTP_PASS", "IMAP_PASS",
      "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_FROM",
      "IMAP_HOST", "IMAP_PORT", "IMAP_USER",
    ]);
  });

  it("keeps SMTP_PASS as the primary the single-entry install path acts on", () => {
    // Order is the whole contract: secretName is credentials[0], and
    // uninstall / /api/integrations/test act on secretName alone. Reordering
    // the list silently repoints them at a hostname.
    expect(load().get("email")!.secretName).toBe("SMTP_PASS");
  });

  it("marks exactly the two passwords as vault-backed", () => {
    const secret = email().credentials.filter(isSecretRequirement).map((c) => c.name);
    expect(secret).toEqual(["SMTP_PASS", "IMAP_PASS"]);
    // The other seven are non-secret config; encrypting a hostname at rest is
    // both wrong and would make email permanently unadvertisable, since the
    // vault-presence gate would never find them there.
    const config = email().credentials.filter((c) => !isSecretRequirement(c)).map((c) => c.name);
    expect(config).toEqual(["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_FROM", "IMAP_HOST", "IMAP_PORT", "IMAP_USER"]);
  });

  it("marks exactly the IMAP half optional, as its own instructions always have", () => {
    // Sending needs the SMTP five; reading needs the IMAP four. A send-only
    // mailbox is a real configuration, so mandatory IMAP made Set Up
    // uncompletable for that user — the modal refuses a blank field — and the
    // junk they had to invent went into the vault.
    const required = email().credentials.filter(isRequiredRequirement).map((c) => c.name);
    expect(required).toEqual(["SMTP_PASS", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_FROM"]);
    const optional = email().credentials.filter((c) => !isRequiredRequirement(c)).map((c) => c.name);
    expect(optional).toEqual(["IMAP_PASS", "IMAP_HOST", "IMAP_PORT", "IMAP_USER"]);
    // The declaration and the prose the user reads in the same modal must agree.
    expect(email().authInstructions).toContain("For reading emails, also set:");
  });

  it("leaves every other builtin's credentials mandatory", () => {
    // `required` absent means required, so the field narrows nothing until a
    // declaration opts out — pinned so a later edit cannot quietly relax the
    // gate for an integration that genuinely cannot run without its key.
    for (const declaration of BUILTIN_INTEGRATIONS.filter((i) => i.id !== "email")) {
      expect(declaration.credentials.every(isRequiredRequirement), declaration.id).toBe(true);
    }
  });

  it("describes every value, so the install modal can label its fields", () => {
    for (const credential of email().credentials) {
      expect(credential.description, credential.name).toBeTruthy();
    }
  });

  it("still renames only the primary when a pre-list file overrides it", () => {
    // The case the sweep below could not reach until email declared more than
    // one credential: a pre-list file names ONE secret, so the override has to
    // be a rename of the primary, never a truncation of the other eight.
    write([preListConfig("email", "MY_SMTP_PASS")]);

    const config = load().get("email")!;
    expect(config.credentials.map((c) => c.name)).toEqual([
      "MY_SMTP_PASS", "IMAP_PASS",
      "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_FROM",
      "IMAP_HOST", "IMAP_PORT", "IMAP_USER",
    ]);
    expect(config.secretName).toBe("MY_SMTP_PASS");
    // The renamed primary keeps its metadata; only the vault entry moved.
    expect(config.credentials[0].secret).toBeUndefined();
    expect(config.credentials[2].secret).toBe(false);
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

/**
 * The shape a saved file actually has for a BUILTIN, and the one that decides
 * whether a declaration change ever reaches a user.
 *
 * save() persists EVERY integration on any markInstalled/setEnabled/
 * addIntegration, so a user who has ever clicked Set Up on ANY integration has
 * an `email` entry frozen with whatever email declared that day. If a saved
 * `credentials` array won outright, that entry would pin email at one credential
 * forever and no future declaration — this chunk's nine included — would reach a
 * single existing user. There is no migration step to lean on.
 *
 * So for a builtin the DECLARATION is authoritative, which is the rule the
 * loader already states one line above ("preserve built-in endpoints/auth
 * metadata; only adopt the user's installed/enabled state") — credentials were
 * wrongly classed as user state. The one genuinely user-authored fact inside
 * them is the primary RENAME (pointing an integration at a different vault
 * entry), so that is re-applied, from either shape a saved file can carry it in.
 *
 * A CUSTOM integration keeps its saved list: there is no declaration to defer to.
 */
describe("a builtin whose saved file predates its current declaration", () => {
  /** email as the build before this chunk saved it: the single credential it then declared. */
  const savedEmail = (extra: Record<string, unknown> = {}) => ({
    id: "email", installed: true, enabled: true,
    credentials: [{ name: "SMTP_PASS" }], secretName: "SMTP_PASS", ...extra,
  });

  const EMAIL_DECLARED = [
    "SMTP_PASS", "IMAP_PASS",
    "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_FROM",
    "IMAP_HOST", "IMAP_PORT", "IMAP_USER",
  ];

  it("picks up the credentials the builtin declares TODAY", () => {
    write([savedEmail()]);

    const config = load().get("email")!;
    expect(config.credentials.map((c) => c.name)).toEqual(EMAIL_DECLARED);
    expect(config.secretName).toBe("SMTP_PASS");
    // Not just the names: the metadata the modal and the gate act on comes from
    // the declaration too, or the user gets nine unlabelled mandatory fields.
    expect(config.credentials.map((c) => c.secret)).toEqual([undefined, undefined, false, false, false, false, false, false, false]);
    expect(config.credentials.map((c) => c.required)).toEqual([undefined, false, undefined, undefined, undefined, undefined, false, false, false]);
  });

  it("is the file EVERY existing user has, written by installing something else", () => {
    // The reach claim, not an assumption: connecting GitHub alone persists an
    // `email` entry carrying that build's credential list.
    const first = load();
    first.markInstalled("github", true);
    const saved = JSON.parse(readFileSync(savedFile(), "utf-8")) as IntegrationConfig[];
    const email = saved.find((s) => s.id === "email")!;
    expect(email.credentials.map((c) => c.name)).toEqual(EMAIL_DECLARED);

    // Now the same file as written by the ONE-credential build.
    write(saved.map((s) => (s.id === "email" ? savedEmail({ installed: false }) : s)));

    expect(load().get("email")!.credentials.map((c) => c.name)).toEqual(EMAIL_DECLARED);
  });

  it("re-applies a primary rename carried in the saved credential list", () => {
    // The repointing feature C3 deliberately kept: the user's own choice of
    // vault entry is the one user-authored fact in a saved credential list.
    write([savedEmail({ credentials: [{ name: "MY_SMTP_PASS" }], secretName: "MY_SMTP_PASS" })]);

    const config = load().get("email")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["MY_SMTP_PASS", ...EMAIL_DECLARED.slice(1)]);
    expect(config.secretName).toBe("MY_SMTP_PASS");
    // The rename moves the vault entry and nothing else.
    expect(config.credentials[0].description).toBe(BUILTIN_INTEGRATIONS.find((i) => i.id === "email")!.credentials[0].description);
  });

  it("re-applies a rename carried in the legacy secretName instead", () => {
    write([{ id: "email", installed: true, enabled: true, secretName: "MY_SMTP_PASS" }]);

    expect(load().get("email")!.credentials.map((c) => c.name)).toEqual(["MY_SMTP_PASS", ...EMAIL_DECLARED.slice(1)]);
  });

  it("does not let a saved file add a credential to a builtin", () => {
    // integrations.json is plain JSON and the vault-presence gate plus the
    // install route both act on the declared list, so an added name would be a
    // credential the user never chose being demanded — and, on install, written.
    write([{ id: "github", installed: true, enabled: true, credentials: [{ name: "GITHUB_TOKEN" }, { name: "ANTHROPIC_API_KEY" }] }]);

    expect(load().get("github")!.credentials.map((c) => c.name)).toEqual(["GITHUB_TOKEN"]);
  });

  it("keeps a CUSTOM integration's saved list, which has no declaration to defer to", () => {
    write([{
      id: "acme", name: "Acme", icon: "🔌", description: "", authType: "api_key",
      authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
      endpoints: [], headers: {}, builtin: false, installed: true, enabled: true,
      credentials: [{ name: "ACME_TOKEN" }, { name: "ACME_HOST", secret: false }],
    }]);

    const config = load().get("acme")!;
    expect(config.credentials.map((c) => c.name)).toEqual(["ACME_TOKEN", "ACME_HOST"]);
    expect(config.secretName).toBe("ACME_TOKEN");
  });
});

describe("loading a post-list integrations.json", () => {
  it("re-applies a saved primary rename over the builtin's declared list", () => {
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

  it("still advertises email once both its passwords are in the vault", () => {
    // email declares no authScope and an empty baseUrl. The gate must neither
    // crash on that nor silently retire the integration. HOW it is rendered is
    // the transport concern pinned in its own block below.
    const registry = load(vault("SMTP_PASS", "IMAP_PASS"));
    registry.markInstalled("email", true);

    expect(registry.getAgentContext()).toContain("(email)");
  });

  // INVERTED. This asserted that email is DROPPED when only SMTP_PASS is in the
  // vault, on the grounds that missingSecretCredentials() is all-or-nothing "by
  // design". It is not any more, and it was never right for email: a send-only
  // mailbox is a working configuration, its authInstructions have always said so
  // ("For reading emails, ALSO set:"), and hiding it pushed the user to invent a
  // junk IMAP_PASS — which then satisfies the gate with a credential guaranteed
  // to fail at runtime. The declaration says which secrets are preconditions;
  // the gate counts those.
  it("still advertises email for a send-only user with no IMAP password", () => {
    const registry = load(vault("SMTP_PASS"));
    registry.markInstalled("email", true);

    expect(registry.getAgentContext()).toContain("(email)");
  });

  it("drops email when the password sending actually needs is missing", () => {
    // The relaxation is not a delete of the gate: SMTP_PASS is required, so an
    // IMAP-only vault still advertises nothing.
    const registry = load(vault("IMAP_PASS"));
    registry.markInstalled("email", true);

    expect(registry.getAgentContext()).toBe("");
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

/**
 * The sibling case the ABSENT-field tests above cannot reach: `endpoints`
 * PRESENT and truthy but not an array. Only `Array.isArray()` rejects that —
 * `declaration.endpoints ?? []` and `|| []` both pass a corrupt value straight
 * through to `.filter()` in getAgentContext(), which throws out of
 * build-system-prompt.ts and kills every request, not just this integration.
 * Nothing type-checks integrations.json on the way in, so a hand edit or a
 * truncated/partial write is all it takes to produce one.
 */
describe("a config whose endpoints field is not an array", () => {
  const corruptEndpoints = {
    id: "acme", name: "Acme", icon: "🔌", description: "Acme API", authType: "api_key" as const,
    authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
    secretName: "ACME_TOKEN", headers: {}, enabled: true, installed: true, builtin: false,
    endpoints: "corrupt",
  };

  it("normalises a truthy non-array to zero endpoints", () => {
    write([corruptEndpoints]);

    const registry = load(vault("ACME_TOKEN"));
    expect(registry.get("acme")!.endpoints).toEqual([]);
    expect(registry.list().every((i) => Array.isArray(i.endpoints))).toBe(true);
  });

  it("still renders the agent context rather than killing the whole request", () => {
    write([corruptEndpoints]);

    const ctx = load(vault("ACME_TOKEN")).getAgentContext();
    expect(ctx).toContain("### 🔌 Acme (acme)");
    expect(ctx).toContain("Base URL: https://api.acme.test");
  });

  it("normalises every other truthy non-array shape the same way", () => {
    // A string is the shape that reads most like a valid field; a number, a
    // boolean and an object are the rest of what JSON can put there. None of
    // them has a .filter, so any one of them is enough to take the process
    // down if the guard degrades to a nullish/falsy check.
    for (const endpoints of ["corrupt", 7, true, { "GET /ping": "ping" }]) {
      write([{ ...corruptEndpoints, endpoints }]);

      const registry = load(vault("ACME_TOKEN"));
      expect(registry.get("acme")!.endpoints, JSON.stringify(endpoints)).toEqual([]);
      expect(registry.getAgentContext(), JSON.stringify(endpoints)).toContain("(acme)");
    }
  });
});

/**
 * The `transport` sibling of the `endpoints` cases above, and the same failure
 * class: a persisted integrations.json is plain JSON nothing type-checks, and
 * POST /api/integrations casts an arbitrary body into addIntegration() after
 * validating only id/name/baseUrl — so a value outside IntegrationTransport
 * reaches the renderer however carefully the TYPE is written. Indexing the
 * transport-tools table with it threw `TypeError: Cannot read properties of
 * undefined (reading 'join')` out of getAgentContext(), whose only caller is
 * build-system-prompt.ts, killing every request and taking every UNRELATED
 * integration in the block down with it.
 *
 * Normalised at the one funnel every config enters through — the same place
 * `endpoints` is — so an unknown transport degrades to the HTTP shape every
 * integration had before the field existed, rather than each reader guarding.
 */
describe("a config whose transport is not one this build knows", () => {
  const unknownTransport = {
    id: "acme", name: "Acme", icon: "🔌", description: "Acme API", authType: "api_key" as const,
    authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
    secretName: "ACME_TOKEN", headers: {}, enabled: true, installed: true, builtin: false,
    endpoints: [{ name: "Ping", method: "GET", path: "/ping", description: "ping" }],
    transport: "grpc",
  };

  it("degrades to http instead of throwing out of the whole request", () => {
    write([unknownTransport]);

    const registry = load(vault("ACME_TOKEN"));
    expect(registry.get("acme")!.transport).toBe("http");
    const ctx = registry.getAgentContext();
    expect(ctx).toContain("Base URL: https://api.acme.test");
    expect(ctx).toContain("- GET /ping — ping");
  });

  it("does not take unrelated integrations down with it", () => {
    // The blast radius is the point: getAgentContext() renders every advertised
    // integration in one pass, so one corrupt entry used to delete GitHub from
    // the model's context too — and then the system prompt entirely.
    write([unknownTransport]);

    const registry = load(vault("ACME_TOKEN", "GITHUB_TOKEN"));
    registry.markInstalled("github", true);

    const ctx = registry.getAgentContext();
    expect(ctx).toContain("(github)");
    expect(ctx).toContain("(acme)");
  });

  it("normalises every non-transport shape JSON can put there", () => {
    // A string is what a hand edit produces; the rest are what a corrupt or
    // partial write can. None of them indexes the transport-tools table, and a
    // key that is NOT own-enumerable there ("toString", "constructor") resolves
    // to an Object.prototype member — truthy, and still no `.join`.
    for (const transport of ["grpc", "toString", "constructor", "", 7, true, null, { http: true }]) {
      write([{ ...unknownTransport, transport }]);

      const registry = load(vault("ACME_TOKEN"));
      expect(registry.get("acme")!.transport, JSON.stringify(transport)).toBe("http");
      expect(registry.getAgentContext(), JSON.stringify(transport)).toContain("Base URL: https://api.acme.test");
    }
  });

  it("normalises the same way when the config arrives through addIntegration", () => {
    // POST /api/integrations validates id/name/baseUrl and casts the rest, so
    // this is the LIVE route, not just a hand-edited file.
    const registry = load(vault("ACME_TOKEN"));
    registry.addIntegration({ ...unknownTransport, credentials: [{ name: "ACME_TOKEN" }] } as unknown as IntegrationDeclaration);

    expect(registry.get("acme")!.transport).toBe("http");
    expect(registry.getAgentContext()).toContain("(acme)");
  });

  it("still honours a transport this build does know", () => {
    // The normaliser must not degrade EVERYTHING to http — then it would just be
    // a delete of the feature.
    const registry = load(vault("SMTP_PASS"));
    registry.markInstalled("email", true);

    expect(registry.get("email")!.transport).toBe("smtp_imap");
    expect(registry.getAgentContext()).toContain("email_send");
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

/**
 * `transport` says how the integration's traffic is actually carried. The whole
 * "Connected API Integrations" block is written for http_request — a base URL
 * you join a path onto — and email fits none of it: no base URL, and
 * "endpoints" that are smtp/imap pseudo-paths. Rendering it in that shape told
 * the model to issue `http_request("" + "smtp")`, which can only fail.
 *
 * It is re-rendered rather than dropped because email genuinely works, through
 * the email_* tools; and the pseudo-paths are withheld because naming them
 * alongside an Endpoints heading is the invitation itself.
 */
describe("agent context transport", () => {
  // Every line of an http entry is http vocabulary — where to send the call,
  // where to put the credential, which paths exist — so a non-http entry keeps
  // only the two lines that are true of it. The `Auth:` line is gone on purpose
  // rather than reworded: it emitted {{SMTP_HOST}}…{{IMAP_USER}} as
  // Authorization-header placeholders for a transport with no headers, seven of
  // which are not vault entries at all, and the email_* tools resolve their own
  // credentials — so there was nothing for the model to do with those names but
  // misuse them. The two http_request instructions in the block header go for
  // the same reason when nothing in the block is an http_request target.
  const EMAIL_CONTEXT =
    "\n## Connected API Integrations\n\n" +
    "### 📧 Email (SMTP/IMAP) (email)\n" +
    "Reached with the email_send, email_read, email_search, email_read_message, email_folders tools — not http_request.\n\n";

  const emailContext = () => {
    const registry = load(vault("SMTP_PASS", "IMAP_PASS"));
    registry.markInstalled("email", true);
    return registry.getAgentContext();
  };

  it("renders a smtp_imap integration as its tools, never as a Base URL", () => {
    expect(emailContext()).toBe(EMAIL_CONTEXT);
  });

  it("names the tools that actually carry it", () => {
    const ctx = emailContext();
    for (const tool of ["email_send", "email_read", "email_search"]) expect(ctx).toContain(tool);
  });

  it("withholds the pseudo-paths http_request cannot reach", () => {
    const ctx = emailContext();
    expect(ctx).not.toContain("Base URL:");
    expect(ctx).not.toContain("Endpoints:");
    for (const line of ["POST smtp", "GET imap", "GET imap/search"]) {
      expect(ctx, `"${line}" is not an http_request target`).not.toContain(line);
    }
  });

  it("does not open an all-smtp block by telling the model to use http_request", () => {
    const ctx = emailContext();
    expect(ctx).not.toContain("http_request tool");
    expect(ctx).not.toContain("{{SECRET_NAME}}");
    // And no {{PLACEHOLDER}} for a transport that has no headers to put one in
    // — least of all for the seven values that are not vault entries at all.
    expect(ctx).not.toContain("{{");
  });

  it("keeps the http_request instructions when the block also holds an http integration", () => {
    // They are true of GitHub, and GitHub's own entry is untouched; email's
    // entry contradicts them locally and specifically.
    const registry = load(vault("GITHUB_TOKEN", "SMTP_PASS"));
    registry.markInstalled("github", true);
    registry.markInstalled("email", true);

    expect(registry.getAgentContext()).toBe(
      PRE_GATE_GITHUB_CONTEXT +
      "### 📧 Email (SMTP/IMAP) (email)\n" +
      "Reached with the email_send, email_read, email_search, email_read_message, email_folders tools — not http_request.\n\n",
    );
  });

  it("leaves an integration that declares no transport rendering exactly as before", () => {
    // `transport` is absent on all ten other builtins, so adding the field must
    // be a no-op for them — pinned byte-for-byte against the pre-transport
    // output, which PRE_GATE_GITHUB_CONTEXT is.
    const registry = load(vault("GITHUB_TOKEN"));
    registry.markInstalled("github", true);

    expect(registry.getAgentContext()).toBe(PRE_GATE_GITHUB_CONTEXT);
    expect(BUILTIN_INTEGRATIONS.filter((i) => i.transport !== undefined).map((i) => i.id)).toEqual(["email"]);
  });

  it("renders an explicit http transport identically to an absent one", () => {
    // "absent means http" has to be a real default, not a second code path.
    const render = (transport: IntegrationDeclaration["transport"]) => {
      const registry = load(vault("ACME_TOKEN"));
      registry.addIntegration(custom({ transport }));
      return registry.getAgentContext();
    };

    expect(render("http")).toBe(render(undefined));
    expect(render(undefined)).toContain("Base URL: https://api.acme.test\n");
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
