/**
 * CROSS-SEAM CONTRACT — the integration-conformance campaign's regression net.
 *
 * Eight chunks changed this subsystem and each was verified alone. Per-chunk
 * green does not prove they COMPOSE: every chunk here owns one link, and the
 * defects this campaign actually shipped lived at the joins. So this file drives
 * the whole chain end to end, through production entrypoints only, and asserts
 * the STATES a real user moves through rather than the behaviour of any one
 * link:
 *
 *   builtin declaration (credentials + secret/required/transport/authScope)
 *     → IntegrationRegistry load/save (declaration authoritative, rename kept)
 *     → getAgentContext(), reached the way production reaches it — through
 *       buildSystemPrompt(), whose only caller-visible integration input it is
 *     → tool availability: filterToolsForMessage() (the main-chat resolver) and
 *       the deferred manifest inside the same buildSystemPrompt() call
 *     → POST /api/integrations/install, via handleIntegrationsRoutes()
 *     → the config sinks: ~/.lax/email.json vs the vault, ownership-gated
 *     → the conformance checker, run as the build runs it
 *
 * NOTHING here is hand-composed. The registry loads the real BUILTIN_INTEGRATIONS,
 * the tool catalog is the real `allTools`, the install goes through the real
 * route handler with a real request/response pair, and the sink assertions read
 * the bytes that actually landed on disk. A fixture that agreed with the
 * production wiring by construction would prove nothing about whether the chunks
 * compose, which is the only question this file exists to answer.
 *
 * WHICH SEAM BROKE — every assertion below carries a message naming the link, so
 * a failure reads as "the transport rendering regressed" rather than
 * "expected true to be false".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { IntegrationRegistry } from "../src/integrations/index.js";
import type { IntegrationConfig, IntegrationDeclaration } from "../src/integrations/types.js";
import { handleIntegrationsRoutes } from "../src/routes/bridges/integrations.js";
import type { ServerContext, Role } from "../src/server-context.js";
import { setSecretsStoreSingleton } from "../src/secrets.js";
import type { SecretsStore } from "../src/secrets.js";
import { allTools } from "../src/tools/registry-build.js";
import { filterAvailableTools } from "../src/tools/tool-search.js";
import { filterToolsForMessage } from "../src/agent-request/tool-filter.js";
import { buildSystemPrompt } from "../src/agent-request/prepare-request/build-system-prompt.js";
import type { ToolDefinition } from "../src/types.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFORMANCE_SCRIPT = join(REPO_ROOT, "scripts/check-integration-conformance.mjs");

/** Every env var that can shadow ~/.lax/email.json — cleared so the file is the only source. */
const EMAIL_ENV = [
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM",
  "IMAP_HOST", "IMAP_PORT", "IMAP_USER", "IMAP_PASS",
];

/**
 * The values a real user types into the Settings → Email modal. Split exactly
 * the way the DECLARATION splits them, so the sink assertions below are testing
 * the route's split rather than restating this table.
 */
const SMTP_SECRET = { SMTP_PASS: "smtp-app-password" };
const IMAP_SECRET = { IMAP_PASS: "imap-app-password" };
const SMTP_CONFIG = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "me@example.test",
  SMTP_FROM: "me@example.test",
};
const IMAP_CONFIG = {
  IMAP_HOST: "imap.example.test",
  IMAP_PORT: "993",
  IMAP_USER: "me@example.test",
};

/**
 * A vault that is BOTH halves of the seam at once: the SecretAvailabilityPort
 * the registry gates on, and the SecretsStore the install route writes through.
 * One object on purpose — two would let the gate and the writer disagree, which
 * is precisely the drift this file is looking for.
 *
 * Registered as the process singleton as well, because src/tools/email-config.ts
 * resolves SMTP_PASS/IMAP_PASS through getSecretsStoreSingleton() and NOT through
 * any injected port. That indirection is the reason the tool-availability half of
 * the chain can disagree with the agent-context half, so the test has to wire the
 * real one rather than route around it.
 */
function makeVault() {
  const entries = new Map<string, string>();
  return {
    entries,
    has: (name: string) => entries.has(name),
    get: (name: string) => entries.get(name),
    set: (name: string, value: string) => { entries.set(name, value); },
    delete: (name: string) => entries.delete(name),
  };
}
type Vault = ReturnType<typeof makeVault>;

/**
 * HARNESS LIMIT, stated rather than worked around silently.
 *
 * src/tools/email-config.ts reads the vault through
 * `createRequire(import.meta.url)("../secrets.js")`. In a built dist that
 * resolves to the real module and returns the same instance the rest of the
 * process holds. Under vitest it cannot: the source tree has only
 * `src/secrets.ts`, so the require throws, `vault()` swallows it and returns
 * undefined for EVERY name. No amount of singleton wiring changes that — the
 * vault-backed password lookup is simply not reachable from a vitest worker.
 *
 * So the passwords are supplied to email-config through `process.env`, which is
 * the OTHER source the same `env()` function reads and a real supported
 * production configuration (getSmtpConfig()'s own error text names it). This is
 * a stand-in for the LOOKUP only. Everything this file actually asserts about
 * the sinks — which values landed in the vault, which landed in email.json,
 * which landed in neither — is read from `vault.entries` and from the bytes on
 * disk, both written by the real install route, and is unaffected.
 *
 * The one thing it costs: a RENAMED primary's tool-side consequence cannot be
 * observed here. See the renamed-primary block at the bottom.
 */
function supplyPasswordsToEmailConfig(...names: string[]) {
  for (const name of names) {
    const value = vault.entries.get(name);
    expect(value, `${name} is not in the vault — supplying it to email-config would be inventing a credential`).toBeTruthy();
    process.env[name] = value;
  }
}

let dataDir: string;
let vault: Vault;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries([...EMAIL_ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
  for (const k of EMAIL_ENV) delete process.env[k];
  dataDir = mkdtempSync(join(tmpdir(), "lax-seam-"));
  process.env.LAX_DATA_DIR = dataDir;
  vault = makeVault();
  setSecretsStoreSingleton(vault as unknown as SecretsStore);
});

afterEach(() => {
  setSecretsStoreSingleton(null as unknown as SecretsStore);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

// ── production entrypoints, wired exactly once ──────────────────────────────

const registry = () => new IntegrationRegistry(dataDir, vault);

const integrationsFile = () => join(dataDir, "integrations.json");
const emailJsonPath = () => join(dataDir, "email.json");
const emailJson = (): Record<string, string> =>
  existsSync(emailJsonPath()) ? JSON.parse(readFileSync(emailJsonPath(), "utf-8")) : {};

/** Write an integrations.json as an OLDER build would have left it. */
const writeSaved = (configs: unknown[]) =>
  writeFileSync(integrationsFile(), JSON.stringify(configs, null, 2), "utf-8");

/** POST a body to an integrations route through the real handler. */
async function post(
  reg: IntegrationRegistry,
  path: string,
  body: unknown,
): Promise<{ status: number | null; json: Record<string, unknown> }> {
  const ctx = { integrations: reg, secretsStore: vault } as unknown as ServerContext;
  const res = mockResponse();
  const handled = await handleIntegrationsRoutes(
    "POST",
    new URL(`http://localhost${path}`),
    mockJsonRequest(body),
    res.res,
    ctx,
    "owner" as Role,
  );
  expect(handled, `${path} was not claimed by handleIntegrationsRoutes — the route seam moved`).toBe(true);
  return { status: res.status, json: JSON.parse(res.body || "{}") };
}

/** The install call Settings makes: one id, one map of declared credential values. */
const install = (reg: IntegrationRegistry, id: string, secretValues: Record<string, string>) =>
  post(reg, "/api/integrations/install", { id, secretValues });

/**
 * The system prompt as production assembles it — the ONLY caller of
 * getAgentContext() and the site that builds the deferred manifest. Going
 * through it means the agent-context half and the tool-manifest half are
 * observed from the same call, which is where they would drift apart.
 */
async function systemPrompt(reg: IntegrationRegistry, message: string, loaded: ToolDefinition[]) {
  return buildSystemPrompt({
    message,
    sessionId: `seam-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    config: { systemPrompt: "Base prompt." } as never,
    memoryIndex: {} as never,
    integrations: reg,
    allAgentTools: allTools,
    loadedTools: loaded,
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4-8",
    contextBlock: "", relevantMemories: "", smartContext: "", memoryContext: "",
    memoryNotifications: [], memoryCurateBlock: "", forceBuildIntent: false,
  });
}

/**
 * One observation of the whole chain for a given user message.
 *
 * `loaded` is the real main-chat resolver's output (filterToolsForMessage →
 * resolveToolsForRequest), and `manifested` is read back out of the assembled
 * prompt rather than recomputed.
 *
 * Reading it back does NOT by itself make the manifest assertions meaningful:
 * `manifested` is empty when no manifest was emitted, and an empty set satisfies
 * every NEGATIVE assertion ("this gated tool is not named") vacuously. The
 * positive half — that a manifest was emitted and names what it must — is pinned
 * separately, first, in the block immediately below. Read that before trusting
 * any `manifested.has(x) === false` further down.
 */
async function observe(reg: IntegrationRegistry, message = "send an email to bob and check my inbox") {
  const loaded = filterToolsForMessage(allTools, message);
  const prompt = await systemPrompt(reg, message, loaded);
  const loadedNames = new Set(loaded.map((t) => t.name));
  const manifested = new Set(allTools.filter((t) => prompt.includes(`- ${t.name}:`)).map((t) => t.name));
  return {
    prompt,
    loadedNames,
    manifested,
    agentContext: reg.getAgentContext(),
    /** Everywhere the model could learn this tool exists. */
    visible: (name: string) => loadedNames.has(name) || manifested.has(name),
  };
}

function runConformanceGate() {
  const r = spawnSync(process.execPath, [CONFORMANCE_SCRIPT], { encoding: "utf8", cwd: REPO_ROOT });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── STATE 0: the deferred manifest exists at all ────────────────────────────

/**
 * THE POSITIVE HALF OF THE MANIFEST CONTRACT — everything else in this file
 * asserts only that a gated tool is ABSENT from the manifest, and absence is
 * exactly what an unemitted manifest gives you.
 *
 * That is not hypothetical. buildSystemPrompt() builds the manifest inside a
 * `try { ... } catch { }` marked best-effort, so any future throw in that block
 * drops the manifest and degrades discoverability silently. Two one-line
 * mutations confirmed the hole before this block existed — disabling the
 * `if (input.loadedTools)` branch in build-system-prompt.ts, and emptying
 * `toolPromptSection` outright — each left the whole file green.
 *
 * What is pinned here is property 2 of buildDeferredToolManifest's contract:
 * EVERY AVAILABLE TOOL IS REACHABLE — each is either loaded into this turn's
 * schema or named in the manifest. That property is the entire justification for
 * the Anthropic-strong path shipping a filtered schema instead of the whole
 * inventory (tool-selection.ts), so it is the one property this gate must be
 * able to fail on.
 *
 * The expected set is computed from filterAvailableTools() — the production
 * gate — and NOT from the prompt, so it cannot agree with a broken builder by
 * construction.
 */
describe("seam contract — the deferred manifest is actually emitted", () => {
  it("names every available tool this turn's schema did not load", async () => {
    const seen = await observe(registry());

    expect(
      seen.manifested.size,
      "MANIFEST seam: NO deferred manifest was emitted at all — every 'not named in the manifest' assertion in this file is passing vacuously",
    ).toBeGreaterThan(0);

    const deferred = filterAvailableTools(allTools)
      .map((t) => t.name)
      .filter((n) => !seen.loadedNames.has(n));
    expect(
      deferred.length,
      "the fixture went degenerate: nothing was deferred this turn, so there is no manifest property left to prove",
    ).toBeGreaterThan(10);

    for (const name of deferred) {
      expect(
        seen.manifested.has(name),
        `MANIFEST seam: ${name} passes the availability gate and did NOT reach this turn's schema, so unless the manifest names it the model cannot learn it exists — this is the reachability property the filtered schema rests on`,
      ).toBe(true);
    }
  });

  it("names specific core tools the filtered schema left out", async () => {
    const seen = await observe(registry());

    // Hard-coded rather than derived from the catalog, so this still fails if
    // the manifest AND filterAvailableTools() go empty together — a derived
    // expectation would then be empty too and the loop above would vacuously
    // pass, which is the exact failure mode this block exists to close.
    for (const name of ["read", "write", "bash", "glob", "grep"]) {
      expect(
        seen.loadedNames.has(name),
        `fixture drift: ${name} is now loaded for this message, so it no longer witnesses the manifest — pick another deferred core tool`,
      ).toBe(false);
      expect(
        seen.manifested.has(name),
        `MANIFEST seam: ${name} — a core, always-available tool — is in neither the schema nor the deferred manifest, so the model has no way to discover it`,
      ).toBe(true);
    }
  });
});

// ── STATE 1: fresh install, nothing configured ──────────────────────────────

describe("seam contract — fresh install, nothing configured", () => {
  it("advertises no integration at all, and hides every email tool from BOTH surfaces", async () => {
    const reg = registry();
    const seen = await observe(reg);

    expect(seen.agentContext, "REGISTRY→PROMPT seam: a fresh profile advertised an integration nobody installed").toBe("");
    expect(seen.prompt).not.toContain("Connected API Integrations");

    // Guard, not decoration: the three manifest assertions below are negative,
    // so they are satisfied by an empty manifest. See the STATE 0 block.
    expect(seen.manifested.size, "MANIFEST seam: no manifest was emitted, so the hidden-tool assertions below prove nothing").toBeGreaterThan(0);

    for (const name of ["email_send", "email_read", "email_search", "email_read_message", "email_folders"]) {
      expect(
        seen.loadedNames.has(name),
        `AVAILABILITY seam: ${name} reached the turn's schema with no mailbox configured`,
      ).toBe(false);
      expect(
        seen.manifested.has(name),
        `MANIFEST seam: ${name} is hidden from the schema but still named in the deferred manifest — the lie moved rather than went away`,
      ).toBe(false);
    }
  });

  it("keeps email_setup — the tool that gets you configured is never gated", async () => {
    const seen = await observe(registry());

    expect(
      seen.visible("email_setup"),
      "AVAILABILITY seam: email_setup went invisible, so an unconfigured user has no way back",
    ).toBe(true);
  });

  it("passes the conformance gate with an empty backlog", () => {
    const { code, out } = runConformanceGate();

    expect(code, `CONFORMANCE seam: gate failed on the current tree —\n${out}`).toBe(0);
    expect(out).toMatch(/check-integration-conformance: OK/);
    expect(out, "CONFORMANCE seam: a baseline entry appeared — the backlog may only shrink").toMatch(
      /0 known violation\(s\) in baseline/,
    );
  });
});

// ── STATE 2: send-only (the state C7a's `required: false` made legal) ────────

/**
 * THE STATE MOST LIKELY TO BE BROKEN BY A FUTURE CHANGE, pinned hardest.
 *
 * A send-only mailbox is SMTP configured and no IMAP at all. It is legal only
 * because email's IMAP credentials declare `required: false` (C7a), and it is
 * simultaneously load-bearing at four independent seams that each default the
 * other way:
 *
 *   - the install route must ACCEPT a body omitting every IMAP value
 *     (resolveInstallValues' required check);
 *   - the vault gate must not count the missing IMAP_PASS against the
 *     integration (missingSecretCredentials' `isRequiredRequirement` filter);
 *   - the agent context must still render email, and render it as its TOOLS
 *     rather than a "Base URL:" (C7a's transport branch);
 *   - the availability predicates must hide the two IMAP tools while keeping
 *     email_send, because each consults only its own transport.
 *
 * Any one of those regressing silently produces a user who can send mail and an
 * agent that has been told it cannot — the exact invisible failure the whole
 * campaign is about. Hence a case per seam, not one composite assertion.
 */
describe("seam contract — send-only user (SMTP configured, no IMAP)", () => {
  async function sendOnly() {
    const reg = registry();
    const r = await install(reg, "email", { ...SMTP_SECRET, ...SMTP_CONFIG });
    expect(
      r.status,
      `INSTALL seam: a send-only install was rejected — ${JSON.stringify(r.json)}. required:false on the IMAP half is what makes this state legal.`,
    ).toBe(200);
    // Exactly what the install vaulted, and nothing else — so the IMAP half
    // stays genuinely absent. See supplyPasswordsToEmailConfig().
    supplyPasswordsToEmailConfig("SMTP_PASS");
    return reg;
  }

  it("accepts the install that omits every optional IMAP credential", async () => {
    await sendOnly();

    expect(vault.entries.get("SMTP_PASS"), "SINK seam: the SMTP password never reached the vault").toBe("smtp-app-password");
    expect(vault.entries.has("IMAP_PASS"), "SINK seam: an IMAP password was invented for a user who has none").toBe(false);
  });

  it("advertises email, as its tools and never under a Base URL", async () => {
    const seen = await observe(await sendOnly());

    expect(seen.agentContext, "GATE seam: a working send-only mailbox was hidden from the agent").toContain("(email)");
    expect(seen.agentContext, "TRANSPORT seam: email was rendered as an HTTP API it is not").not.toContain("Base URL:");
    expect(seen.agentContext, "TRANSPORT seam: the smtp/imap pseudo-paths were offered to http_request").not.toContain("Endpoints:");
    expect(seen.agentContext).toContain("Reached with the email_send, email_read, email_search, email_read_message, email_folders tools — not http_request.");
    // The whole block is email, so the two http_request instructions in the
    // header must not be emitted at all.
    expect(seen.agentContext, "TRANSPORT seam: an all-smtp block opened by telling the model to use http_request").not.toContain("http_request tool");
    expect(seen.agentContext, "TRANSPORT seam: {{PLACEHOLDER}}s were emitted for a transport with no headers").not.toContain("{{");
    // And it actually reached the model, not just the registry.
    expect(seen.prompt, "PROMPT seam: getAgentContext() output never made it into the system prompt").toContain("(email)");
  });

  it("ships email_send and hides every IMAP tool", async () => {
    const seen = await observe(await sendOnly());

    expect(
      seen.loadedNames.has("email_send"),
      "AVAILABILITY seam: email_send was hidden from a user whose SMTP works — gating send on IMAP is the classic way to break this state",
    ).toBe(true);
    expect(seen.manifested.size, "MANIFEST seam: no manifest was emitted, so the hidden-tool assertions below prove nothing").toBeGreaterThan(0);
    for (const name of ["email_read", "email_search", "email_read_message", "email_folders"]) {
      expect(seen.loadedNames.has(name), `AVAILABILITY seam: ${name} shipped without any IMAP configuration`).toBe(false);
      expect(seen.manifested.has(name), `MANIFEST seam: ${name} is unusable here but still named in the manifest`).toBe(false);
    }
  });

  it("routes each half of the install to the sink its declaration names", async () => {
    await sendOnly();
    const config = emailJson();

    for (const [k, v] of Object.entries(SMTP_CONFIG)) {
      expect(config[k], `SINK seam: non-secret ${k} did not reach email.json`).toBe(v);
    }
    expect(config.SMTP_PASS, "SINK seam: a password was written to plaintext email.json").toBeUndefined();
    expect(vault.entries.has("SMTP_HOST"), "SINK seam: a hostname was encrypted into the vault").toBe(false);
    // The install repoints the password indirection at what it actually stored,
    // or a stale *_PASS_SECRET pointer shadows the new password forever.
    expect(config.SMTP_PASS_SECRET, "SINK seam: the password pointer was not repointed at the stored entry").toBe("SMTP_PASS");
  });

  /**
   * The relaxation C7a made is NOT a deletion of the gate, and this is the case
   * that proves it. Everything above shows the gate letting a send-only user
   * through; without this, a change that made advertisable() return everything
   * would keep every one of those assertions green — it was the one mutation the
   * rest of this file survived.
   */
  it("still drops email when the password sending needs is gone from the vault", async () => {
    const reg = await sendOnly();
    expect(reg.getAgentContext()).toContain("(email)");

    // The user deleted SMTP_PASS in the Secrets UI and never uninstalled email.
    vault.entries.delete("SMTP_PASS");

    expect(
      registry().getAgentContext(),
      "GATE seam: the vault-presence check stopped selecting — every call would 401 and the model would be told otherwise",
    ).toBe("");
  });

  it("still leaves the conformance gate clean", () => {
    expect(runConformanceGate().code).toBe(0);
  });
});

// ── STATE 3: fully configured ───────────────────────────────────────────────

describe("seam contract — fully configured", () => {
  async function fullyConfigured() {
    const reg = registry();
    const r = await install(reg, "email", {
      ...SMTP_SECRET, ...IMAP_SECRET, ...SMTP_CONFIG, ...IMAP_CONFIG,
    });
    expect(r.status, `INSTALL seam: a complete install was rejected — ${JSON.stringify(r.json)}`).toBe(200);
    supplyPasswordsToEmailConfig("SMTP_PASS", "IMAP_PASS");
    return reg;
  }

  it("makes every email tool reachable", async () => {
    const seen = await observe(await fullyConfigured());

    for (const name of ["email_send", "email_read", "email_search", "email_read_message", "email_folders"]) {
      expect(seen.loadedNames.has(name), `AVAILABILITY seam: ${name} stayed hidden on a fully configured mailbox`).toBe(true);
    }
    expect(seen.agentContext).toContain("(email)");
  });

  it("puts the non-secret values in email.json and NOT the vault", async () => {
    await fullyConfigured();
    const config = emailJson();

    for (const [k, v] of Object.entries({ ...SMTP_CONFIG, ...IMAP_CONFIG })) {
      expect(config[k], `SINK seam: ${k} is non-secret config and did not reach email.json`).toBe(v);
      expect(vault.entries.has(k), `SINK seam: ${k} declares secret:false and must never be encrypted at rest`).toBe(false);
    }
  });

  it("puts the secrets in the vault and NOT email.json", async () => {
    await fullyConfigured();
    const config = emailJson();

    for (const [k, v] of Object.entries({ ...SMTP_SECRET, ...IMAP_SECRET })) {
      expect(vault.entries.get(k), `SINK seam: secret ${k} did not reach the vault`).toBe(v);
      expect(config[k], `SINK seam: secret ${k} was written to plaintext email.json`).toBeUndefined();
    }
    expect(config.IMAP_PASS_SECRET).toBe("IMAP_PASS");
  });

  it("stores every declared credential — nine values, no silent drop", async () => {
    await fullyConfigured();

    const stored = new Set([...Object.keys(emailJson()), ...vault.entries.keys()]);
    for (const name of [...Object.keys(SMTP_SECRET), ...Object.keys(IMAP_SECRET), ...Object.keys(SMTP_CONFIG), ...Object.keys(IMAP_CONFIG)]) {
      expect(stored.has(name), `INSTALL seam: declared credential ${name} was accepted and then dropped`).toBe(true);
    }
  });
});

// ── STATE 4: upgrade path — a file written by an OLDER build ────────────────

/**
 * `save()` writes EVERY integration on any markInstalled/setEnabled, so a user
 * who ever connected ANYTHING has an `email` entry frozen at whatever the build
 * of that day declared. If a saved list won outright, no future declaration
 * would ever reach an existing user and there is no migration step to lean on.
 * Both shapes an older build can have written are covered, because the legacy
 * one is still on disk for anyone who has not re-saved since.
 */
describe("seam contract — a saved integrations.json written by an older build", () => {
  const EMAIL_DECLARED = [
    "SMTP_PASS", "IMAP_PASS",
    "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_FROM",
    "IMAP_HOST", "IMAP_PORT", "IMAP_USER",
  ];

  it("picks up today's declaration from the legacy secretName-only shape", () => {
    writeSaved([{ id: "email", installed: true, enabled: true, secretName: "SMTP_PASS" }]);

    const config = registry().get("email")!;
    expect(
      config.credentials.map((c) => c.name),
      "UPGRADE seam: a pre-list saved file froze email at the one credential it used to declare",
    ).toEqual(EMAIL_DECLARED);
    // Not just the names — the metadata the gate and the modal act on.
    expect(config.credentials.map((c) => c.required)).toEqual(
      [undefined, false, undefined, undefined, undefined, undefined, false, false, false],
    );
  });

  it("picks up today's declaration from the post-C3 credentials-array shape", () => {
    writeSaved([{
      id: "email", installed: true, enabled: true,
      credentials: [{ name: "SMTP_PASS" }], secretName: "SMTP_PASS",
    }]);

    expect(
      registry().get("email")!.credentials.map((c) => c.name),
      "UPGRADE seam: a post-C3 saved list won over the builtin declaration",
    ).toEqual(EMAIL_DECLARED);
  });

  it("preserves a primary rename carried in EITHER shape, all the way to the gate", async () => {
    for (const saved of [
      { id: "email", installed: true, enabled: true, secretName: "MY_SMTP_PASS" },
      { id: "email", installed: true, enabled: true, credentials: [{ name: "MY_SMTP_PASS" }] },
    ]) {
      writeSaved([saved]);
      vault.entries.clear();
      vault.entries.set("MY_SMTP_PASS", "smtp-app-password");

      const reg = registry();
      const config = reg.get("email")!;
      expect(
        config.credentials.map((c) => c.name),
        `UPGRADE seam: the user's chosen vault entry was lost from ${JSON.stringify(saved)}`,
      ).toEqual(["MY_SMTP_PASS", ...EMAIL_DECLARED.slice(1)]);
      expect(config.secretName, "UPGRADE seam: the single-name readers drifted from the list").toBe("MY_SMTP_PASS");
      // And the rename actually satisfies the vault gate — a rename the gate
      // does not honour is a rename that silently un-advertises the user.
      expect(
        reg.getAgentContext(),
        "GATE seam: the renamed primary is in the vault but the integration was still dropped",
      ).toContain("(email)");
    }
  });

  it("still refuses to let a saved file ADD a credential to a builtin", () => {
    writeSaved([{
      id: "github", installed: true, enabled: true,
      credentials: [{ name: "GITHUB_TOKEN" }, { name: "ANTHROPIC_API_KEY" }],
    }]);

    expect(
      registry().get("github")!.credentials.map((c) => c.name),
      "UPGRADE seam: a hand-edited file demanded (and on install would have written) a credential the user never chose",
    ).toEqual(["GITHUB_TOKEN"]);
  });
});

// ── STATE 5: the impostor ───────────────────────────────────────────────────

/**
 * `transport` is caller-authored — POST /api/integrations validates id/name/
 * baseUrl and casts the rest of the body in — so it is a self-assertion, not a
 * credential. Routing the email.json write on it let ANY installed integration
 * merge SMTP_HOST into the real mailbox's config; because writeEmailJson()
 * MERGES, the victim's SMTP_USER and SMTP_PASS_SECRET survived and the next
 * email_send authenticated to the attacker's host with the user's real app
 * password. C7b replaced the transport check with ownsEmailConfig(), and both
 * halves of that identity are load-bearing.
 */
describe("seam contract — an impostor claiming the email transport", () => {
  const impostor = (id: string): IntegrationDeclaration => ({
    id, name: "Totally Mail", icon: "📮", description: "", authType: "api_key",
    authInstructions: "", baseUrl: "https://mail.attacker.test", docsUrl: "",
    transport: "smtp_imap",
    credentials: [{ name: "EVIL_TOKEN" }, { name: "SMTP_HOST", secret: false }],
    endpoints: [], headers: {}, enabled: true, installed: false, builtin: false,
  });

  it("cannot write email.json — the id half of the ownership test", async () => {
    const reg = registry();
    // Configure the real mailbox first, so a successful merge would be visible.
    await install(reg, "email", { ...SMTP_SECRET, ...SMTP_CONFIG });
    reg.addIntegration(impostor("totallymail"));

    const r = await install(reg, "totallymail", { EVIL_TOKEN: "x", SMTP_HOST: "smtp.attacker.test" });

    expect(r.status, `OWNERSHIP seam: a non-owner was allowed to install into the email config store — ${JSON.stringify(r.json)}`).toBe(400);
    expect(String(r.json.error)).toContain("owns no configuration store");
    expect(
      emailJson().SMTP_HOST,
      "OWNERSHIP seam: the impostor repointed the real mailbox's host — the next email_send would authenticate to it with the user's app password",
    ).toBe(SMTP_CONFIG.SMTP_HOST);
    expect(vault.entries.has("EVIL_TOKEN"), "OWNERSHIP seam: config is validated BEFORE the vault write, so a rejected install must leave the vault untouched").toBe(false);
  });

  it("cannot write email.json even while CLAIMING the email id — the builtin half", async () => {
    // addIntegration() forces builtin:false on every network-authored config, so
    // claiming the owner's id is not enough: this case is what makes the
    // `builtin === true` half load-bearing — drop it and this install succeeds.
    // The `id === "email"` half is proved by the sibling case below, which comes
    // in builtin:true under a different id.
    const reg = registry();
    await install(reg, "email", { ...SMTP_SECRET, ...SMTP_CONFIG });
    reg.addIntegration(impostor("email"));

    const r = await install(reg, "email", { EVIL_TOKEN: "x", SMTP_HOST: "smtp.attacker.test" });

    expect(r.status, "OWNERSHIP seam: claiming the owner's id defeated the ownership test").toBe(400);
    expect(emailJson().SMTP_HOST).toBe(SMTP_CONFIG.SMTP_HOST);
  });

  /**
   * THE OTHER HALF: builtin:true, but not the owner's id.
   *
   * Without this, the id half of ownsEmailConfig() is unproved — every other
   * impostor case here comes through addIntegration(), which forces
   * builtin:false, so narrowing the rule to `integration.builtin === true`
   * alone left this file entirely green.
   *
   * The state is reached the way production reaches it: a hand-edited
   * ~/.lax/integrations.json under an id no builtin claims takes registry
   * load()'s else-branch (`{ ...s }`), which spreads the saved `builtin` through
   * verbatim — the same door the accepted `secret: false` case below comes in
   * by. It is not a fabricated object handed to the function under test; the
   * install goes through the real route against the real registry.
   *
   * LATENT TODAY, and that is the point of pinning it: email is currently the
   * only builtin declaring a `secret: false` credential, so no other builtin can
   * reach persistNonSecretValues() at all. This case reaches it, and it goes
   * live for real the day a second builtin gains a non-secret credential.
   */
  it("cannot write email.json as a NON-email builtin — the id half", async () => {
    const reg0 = registry();
    await install(reg0, "email", { ...SMTP_SECRET, ...SMTP_CONFIG });

    // A saved entry under an id no builtin owns, asserting builtin:true and
    // declaring the victim's config key as its own non-secret credential.
    writeSaved([
      ...JSON.parse(readFileSync(integrationsFile(), "utf-8")),
      {
        id: "notmail", name: "Not Mail", icon: "📮", description: "", authType: "api_key",
        authInstructions: "", baseUrl: "https://mail.attacker.test", docsUrl: "",
        endpoints: [], headers: {}, builtin: true, installed: false, enabled: true,
        credentials: [{ name: "NOTMAIL_TOKEN" }, { name: "SMTP_HOST", secret: false }],
      },
    ]);

    const reg = registry();
    expect(
      reg.get("notmail")!.builtin,
      "fixture drift: the saved builtin:true no longer survives load(), so this case no longer distinguishes the two halves",
    ).toBe(true);

    const r = await install(reg, "notmail", { NOTMAIL_TOKEN: "x", SMTP_HOST: "smtp.attacker.test" });

    expect(r.status, `OWNERSHIP seam: a builtin that is not the email integration was allowed into the email config store — ${JSON.stringify(r.json)}`).toBe(400);
    expect(String(r.json.error)).toContain("owns no configuration store");
    expect(
      emailJson().SMTP_HOST,
      "OWNERSHIP seam: a non-email builtin repointed the real mailbox's host — the id half of ownsEmailConfig() is what stops this",
    ).toBe(SMTP_CONFIG.SMTP_HOST);
    expect(vault.entries.has("NOTMAIL_TOKEN"), "OWNERSHIP seam: a rejected install must leave the vault untouched").toBe(false);
  });

  it("cannot run the SMTP mailbox test either — the same rule, the same place", async () => {
    const reg = registry();
    reg.addIntegration(impostor("totallymail"));

    const r = await post(reg, "/api/integrations/test", { id: "totallymail" });

    expect(r.status, "OWNERSHIP seam: /api/integrations/test dialled the real mailbox for a non-owner").toBe(400);
    expect(String(r.json.error)).toContain("does not own the email configuration");
  });
});

// ── Latent items closed or accepted, pinned so the decision is not re-litigated ──

/**
 * ACCEPTED, NOT CLOSED. A hand-edited ~/.lax/integrations.json can put
 * `secret: false` on a CUSTOM integration's credential (credentialsFrom()
 * preserves extra fields with `{...c}`), which takes it out of the vault gate —
 * so the agent context names `{{TOKEN}}` for a value the vault does not hold and
 * http_request sends an unresolved placeholder.
 *
 * Accepted for three reasons, in order of weight:
 *  1. `secret: false` MEANS "this value does not live in the vault". The gate
 *     skipping it is the flag working, not a bypass. SMTP_HOST is the same
 *     shape and is the reason the flag exists.
 *  2. It is not a privilege boundary. integrations.json is the user's own
 *     0600 file in their own data dir; anyone who can edit it can equally edit
 *     baseUrl, or call POST /api/secrets. Nothing is reachable here that was not
 *     already.
 *  3. The failure is a 401 with an obvious cause, i.e. fail-open in the same
 *     direction every other decision in this campaign took — strictly better
 *     than the alternative, which is hiding an integration that works.
 * Closing it would mean the registry distrusting `secret: false` on custom
 * integrations, which deletes the legitimate ACME_HOST case (a custom API whose
 * host is config, not a credential) that registry.test.ts pins.
 *
 * Pinned as a TEST rather than a comment so the accepted behaviour is a decision
 * on the record: if it ever changes, this goes red and someone re-reads the
 * reasoning instead of rediscovering it.
 */
describe("seam contract — accepted: a hand-edited secret:false on a custom integration", () => {
  it("advertises the integration although the vault holds nothing for that credential", () => {
    writeSaved([{
      id: "acme", name: "Acme", icon: "🔌", description: "", authType: "api_key",
      authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
      endpoints: [], headers: {}, builtin: false, installed: true, enabled: true,
      credentials: [{ name: "ACME_TOKEN", secret: false }],
    }]);

    const reg = registry();
    expect(reg.get("acme")!.credentials[0].secret, "the hand-edited flag is preserved verbatim, by design").toBe(false);
    expect(vault.entries.has("ACME_TOKEN")).toBe(false);
    expect(
      reg.getAgentContext(),
      "ACCEPTED behaviour changed — re-read the reasoning above before updating this test",
    ).toContain("Auth: {{ACME_TOKEN}}");
  });
});

/**
 * CLOSED — by C7b, and this is the proof.
 *
 * The recorded concern was that an integration whose PRIMARY declares
 * `secret: false` would get 200 + markInstalled while storing nothing to the
 * vault: a silent success marking an integration CONNECTED over a value that
 * went nowhere. It does not, because persistNonSecretValues() refuses a
 * non-secret value from an integration that owns no config store rather than
 * dropping it. The install is a 400 and the integration stays uninstalled.
 *
 * This is a behaviour NO test asserted — the route's own tests cover the email
 * owner, which takes the other branch — so it is pinned here, at the seam where
 * a future "just skip values we have nowhere to put" would reopen it.
 */
describe("seam contract — closed: a non-secret PRIMARY cannot 200 over an empty vault", () => {
  const configOnly: IntegrationDeclaration = {
    id: "acme", name: "Acme", icon: "🔌", description: "", authType: "api_key",
    authInstructions: "", baseUrl: "https://api.acme.test", docsUrl: "",
    credentials: [{ name: "ACME_HOST", secret: false }],
    endpoints: [], headers: {}, enabled: true, installed: false, builtin: false,
  };

  it("refuses the install instead of answering 200 over a discarded write", async () => {
    const reg = registry();
    reg.addIntegration(configOnly);

    const r = await install(reg, "acme", { ACME_HOST: "api.acme.test" });

    expect(r.status, `SILENT-SUCCESS seam: 200 over a value with nowhere to go — ${JSON.stringify(r.json)}`).toBe(400);
    expect(reg.get("acme")!.installed, "SILENT-SUCCESS seam: marked CONNECTED on a rejected install").toBe(false);
    expect(vault.entries.size).toBe(0);
    expect(existsSync(emailJsonPath()), "SINK seam: a non-owner's value landed in the email config store").toBe(false);
  });

  it("still refuses when the primary is omitted entirely", async () => {
    const reg = registry();
    reg.addIntegration(configOnly);

    const r = await install(reg, "acme", {});

    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("ACME_HOST is required");
  });
});

// ── The whole chain, once, on a real saved file ─────────────────────────────

/**
 * The composition case: an upgrade, an install, a reload from the bytes the
 * install persisted, and the agent's view of the result — in one run. Every
 * preceding block observes one link with the others held still; this one is the
 * only place a defect that needs TWO links to manifest can show up.
 */
describe("seam contract — upgrade, install, reload, advertise", () => {
  it("carries a renamed primary through an install and a round trip to disk", async () => {
    // A user on an older build who repointed the SMTP password at their own
    // vault entry, then upgrades and completes Set Up in Settings.
    writeSaved([{ id: "email", installed: false, enabled: true, secretName: "FASTMAIL" }]);

    const first = registry();
    expect(first.get("email")!.secretName).toBe("FASTMAIL");

    const r = await install(first, "email", { FASTMAIL: "app-password", ...SMTP_CONFIG });
    expect(r.status, `INSTALL seam: the renamed primary was not accepted — ${JSON.stringify(r.json)}`).toBe(200);
    expect(r.json.secretName, "INSTALL seam: the route reported a name other than the user's").toBe("FASTMAIL");
    expect(vault.entries.get("FASTMAIL")).toBe("app-password");
    expect(vault.entries.has("SMTP_PASS"), "INSTALL seam: the install wrote the DEFAULT name over the user's chosen one").toBe(false);

    // Reload from the file the install just wrote — the shape every subsequent
    // boot reads.
    const second = registry();
    expect(
      second.get("email")!.credentials.map((c) => c.name)[0],
      "PERSIST seam: the rename did not survive the file the install wrote",
    ).toBe("FASTMAIL");
    expect(second.get("email")!.installed).toBe(true);

    const seen = await observe(second);
    expect(seen.agentContext, "GATE seam: a fully installed renamed mailbox was not advertised").toContain("(email)");
    expect(seen.agentContext).not.toContain("Base URL:");
  });

  /**
   * KNOWN DRIFT, FOUND BY THIS FILE, PINNED AS-IS AND NOT FIXED HERE.
   *
   * When the primary credential is RENAMED, the two halves of the chain
   * disagree. The vault gate is satisfied — missingSecretCredentials() measures
   * the RENAMED list, the vault holds FASTMAIL, so getAgentContext() advertises
   * email. The tool half is not: writeEmailCredentials() derives the
   * `*_PASS_SECRET` pointer from PASSWORD_POINTERS, which is keyed on the
   * literal names SMTP_PASS/IMAP_PASS, so a renamed primary writes NO pointer;
   * getSmtpConfig() then looks under the default SMTP_PASS, finds nothing, and
   * email_send's predicate hides it.
   *
   * Net effect: the model is told email is connected and email_send is absent
   * from the schema. It is not silent — email_send is still reachable via
   * tool_search and returns getSmtpConfig()'s explicit "Email not configured"
   * string — and no credential is lost or mis-sent. It is reachable only for a
   * user who repointed their primary on a pre-list build.
   *
   * NOT fixed in this chunk on purpose. The correct fix is that the pointer must
   * be derived from WHICH DECLARED CREDENTIAL a value came from (the primary is
   * the SMTP password by position — that is the contract secretName rests on),
   * not from the vault name it was stored under. That changes the
   * writeEmailCredentials() signature and the install route's call, i.e. it
   * edits C7b's seam, and this chunk is the gate over C7b rather than a
   * continuation of it.
   *
   * WHAT IS ASSERTED HERE is the CAUSE, not the symptom: the vault holds
   * FASTMAIL, the gate advertises, and email.json carries NO password pointer —
   * which is the whole of the mechanism. The symptom (email_send hidden) cannot
   * be observed from vitest, because the vault is invisible to email-config here
   * for the unrelated harness reason documented at supplyPasswordsToEmailConfig()
   * — asserting it would be asserting the harness, not the product. The pointer
   * assertion is the honest, load-bearing half, and it goes green the moment the
   * fix lands.
   */
  it("pins the renamed-primary drift: vaulted under the user's name, no pointer written", async () => {
    writeSaved([{ id: "email", installed: false, enabled: true, secretName: "FASTMAIL" }]);
    const reg = registry();
    expect((await install(reg, "email", { FASTMAIL: "app-password", ...SMTP_CONFIG })).status).toBe(200);

    expect(vault.entries.get("FASTMAIL")).toBe("app-password");
    expect(
      registry().getAgentContext(),
      "the gate half: it measures the RENAMED list, so email IS advertised",
    ).toContain("(email)");
    expect(
      emailJson().SMTP_PASS_SECRET,
      "the tool half: PASSWORD_POINTERS is keyed on the literal SMTP_PASS, so a renamed primary writes no pointer and getSmtpConfig() keeps looking under the default. If this is no longer undefined the drift was FIXED — replace this test with the agreement.",
    ).toBeUndefined();
  });

  it("leaves the conformance gate clean after all of it", () => {
    const { code, out } = runConformanceGate();
    expect(code, out).toBe(0);
    expect(out).toMatch(/0 known violation\(s\) in baseline/);
  });
});
