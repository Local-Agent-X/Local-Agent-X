import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import { handleIntegrationsRoutes } from "./integrations.js";

// Shapes the registry produces: `secretName` is the DERIVED primary, and
// `credentials` is the full declared list (one entry for most builtins, several
// for a service like email).
const MULTI = {
  id: "email",
  name: "Email",
  secretName: "SMTP_PASS",
  credentials: [{ name: "SMTP_PASS" }, { name: "IMAP_PASS" }, { name: "SMTP_HOST", secret: false }],
};
const SINGLE = {
  id: "github",
  name: "GitHub",
  secretName: "GITHUB_TOKEN",
  credentials: [{ name: "GITHUB_TOKEN" }],
};

function makeReq(body?: unknown): Readable & { headers: Record<string, string> } {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) { res.headers.set(name, value); },
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

// A seeded vault entry is [name, value, owner] — `owner` is the `service`
// metadata SecretsStore records at write time, which is how uninstall knows
// which entries THIS integration's install actually wrote.
type VaultSeed = Array<[string, string, string?]>;

async function request(
  path: string,
  body: unknown,
  config: unknown = MULTI,
  vaultSeed: VaultSeed = [],
) {
  const vault = new Map<string, string>();
  const owners = new Map<string, string | undefined>();
  for (const [name, value, owner] of vaultSeed) { vault.set(name, value); owners.set(name, owner); }
  const secretsStore = {
    set: vi.fn((name: string, value: string, meta?: unknown) => {
      vault.set(name, value);
      owners.set(name, typeof meta === "string" ? meta : (meta as { service?: string } | undefined)?.service);
    }),
    delete: vi.fn((name: string) => { owners.delete(name); return vault.delete(name); }),
    getMeta: vi.fn((name: string) => (vault.has(name) ? { name, service: owners.get(name) } : undefined)),
  };
  const integrations = {
    get: vi.fn(() => config),
    markInstalled: vi.fn(),
  };
  const req = makeReq(body);
  const res = makeRes();
  await handleIntegrationsRoutes(
    "POST",
    new URL(`http://127.0.0.1${path}`),
    req as unknown as Parameters<typeof handleIntegrationsRoutes>[2],
    res as unknown as Parameters<typeof handleIntegrationsRoutes>[3],
    { secretsStore, integrations } as unknown as Parameters<typeof handleIntegrationsRoutes>[4],
    "operator",
  );
  return { res, vault, owners, secretsStore, integrations };
}

describe("integration install with multiple declared credentials", () => {
  it("stores every supplied value under the credential it was declared as", async () => {
    const result = await request("/api/integrations/install", {
      id: "email",
      secretValues: { SMTP_PASS: "smtp-secret", IMAP_PASS: "imap-secret" },
    });

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([["SMTP_PASS", "smtp-secret"], ["IMAP_PASS", "imap-secret"]]);
    expect(result.integrations.markInstalled).toHaveBeenCalledWith("email", true);
  });

  it("keeps a bare secretValue meaning the primary credential", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValue: "ghp-token" }, SINGLE);

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([["GITHUB_TOKEN", "ghp-token"]]);
    expect(result.secretsStore.set).toHaveBeenCalledWith("GITHUB_TOKEN", "ghp-token", "GitHub");
  });

  it("rejects an undeclared credential name without writing anything", async () => {
    const result = await request("/api/integrations/install", {
      id: "email",
      secretValues: { SMTP_PASS: "smtp-secret", ANTHROPIC_API_KEY: "stolen" },
    });

    expect(result.res.statusCode).toBe(400);
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect([...result.vault]).toEqual([]);
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("never writes a non-secret requirement to the vault", async () => {
    const result = await request("/api/integrations/install", {
      id: "email",
      secretValues: { SMTP_PASS: "smtp-secret", SMTP_HOST: "smtp.example.com" },
    });

    expect(result.res.statusCode).toBe(200);
    expect(result.vault.has("SMTP_HOST")).toBe(false);
    expect(result.vault.get("SMTP_PASS")).toBe("smtp-secret");
  });

  it("deletes every declared credential on uninstall, not just the primary", async () => {
    const result = await request("/api/integrations/uninstall", { id: "email" }, MULTI, [
      ["SMTP_PASS", "smtp-secret", "Email"],
      ["IMAP_PASS", "imap-secret", "Email"],
    ]);

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([]);
    expect(result.secretsStore.delete).toHaveBeenCalledWith("IMAP_PASS");
    expect(result.integrations.markInstalled).toHaveBeenCalledWith("email", false);
  });

  // ── Silent-success and shape rejection ──

  it("rejects a non-string secretValue instead of silently succeeding", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValue: 12345 }, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Credential GITHUB_TOKEN must be a string" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect([...result.vault]).toEqual([]);
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("rejects a null secretValue rather than marking the integration connected", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValue: null }, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("lets an explicit secretValues entry win over the bare secretValue", async () => {
    const result = await request(
      "/api/integrations/install",
      { id: "github", secretValues: { GITHUB_TOKEN: "from-map" }, secretValue: "from-legacy" },
      SINGLE,
    );

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([["GITHUB_TOKEN", "from-map"]]);
  });

  it("rejects an unparseable install body before touching the registry", async () => {
    const result = await request("/api/integrations/install", undefined, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Invalid JSON" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("skips an empty value rather than writing an empty credential", async () => {
    const result = await request("/api/integrations/install", {
      id: "email",
      secretValues: { SMTP_PASS: "smtp-secret", IMAP_PASS: "" },
    });

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([["SMTP_PASS", "smtp-secret"]]);
    expect(result.secretsStore.set).toHaveBeenCalledTimes(1);
  });

  it("rejects a secretValues that is not an object", async () => {
    for (const secretValues of ["GITHUB_TOKEN", 7, ["GITHUB_TOKEN"], null]) {
      const result = await request("/api/integrations/install", { id: "github", secretValues }, SINGLE);

      expect(result.res.statusCode).toBe(400);
      expect(JSON.parse(result.res.body)).toEqual({ error: "secretValues must be an object" });
      expect(result.secretsStore.set).not.toHaveBeenCalled();
    }
  });

  it("still returns the primary secretName so single-credential callers are unchanged", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValue: "ghp-token" }, SINGLE);

    expect(JSON.parse(result.res.body)).toEqual({ ok: true, id: "github", secretName: "GITHUB_TOKEN" });
  });

  // ── Uninstall is bounded by what install wrote ──

  it("deletes nothing when the declared credentials were not written by this install", async () => {
    const EVIL = {
      id: "evil",
      name: "Evil",
      secretName: "ANTHROPIC_API_KEY",
      credentials: [{ name: "ANTHROPIC_API_KEY" }, { name: "OPENAI_API_KEY" }, { name: "GITHUB_TOKEN" }],
    };
    const result = await request("/api/integrations/uninstall", { id: "evil" }, EVIL, [
      ["ANTHROPIC_API_KEY", "sk-ant", "Anthropic"],
      ["OPENAI_API_KEY", "sk-oai", "OpenAI"],
      ["GITHUB_TOKEN", "ghp", "GitHub"],
    ]);

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault.keys()]).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"]);
    expect(result.secretsStore.delete).not.toHaveBeenCalled();
  });

  it("leaves a credential the user owns while deleting the one this install wrote", async () => {
    const result = await request("/api/integrations/uninstall", { id: "email" }, MULTI, [
      ["SMTP_PASS", "smtp-secret", "Email"],
      ["IMAP_PASS", "imap-secret", undefined],
    ]);

    expect([...result.vault.keys()]).toEqual(["IMAP_PASS"]);
    expect(result.secretsStore.delete).toHaveBeenCalledTimes(1);
    expect(result.secretsStore.delete).toHaveBeenCalledWith("SMTP_PASS");
  });

  it("deletes exactly what a round-trip install recorded as its own", async () => {
    const installed = await request("/api/integrations/install", {
      id: "email",
      secretValues: { SMTP_PASS: "smtp-secret", IMAP_PASS: "imap-secret" },
    });
    const seed: VaultSeed = [...installed.vault].map(([name, value]) => [name, value, installed.owners.get(name)]);
    // SMTP_HOST is DECLARED but `secret: false`, so install never wrote it. An
    // entry of that name the user put there themselves must survive uninstall.
    seed.push(["SMTP_HOST", "smtp.example.com", undefined]);
    const uninstalled = await request("/api/integrations/uninstall", { id: "email" }, MULTI, seed);

    expect([...uninstalled.vault.keys()]).toEqual(["SMTP_HOST"]);
    expect(uninstalled.secretsStore.delete.mock.calls.flat()).toEqual(["SMTP_PASS", "IMAP_PASS"]);
  });
});
