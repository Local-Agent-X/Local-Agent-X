import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import { handleIntegrationsRoutes } from "./integrations.js";

// Shapes the registry produces: `secretName` is the DERIVED primary (always
// credentials[0].name), and `credentials` is the full declared list — one entry
// for every builtin today, several for a service like email.
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
// What `POST /api/integrations {id,name,baseUrl}` yields: no credential list at
// all, so the derived primary is the empty string.
const NO_CREDENTIALS = {
  id: "bare",
  name: "Bare",
  secretName: "",
  credentials: [] as Array<{ name: string }>,
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

async function request(
  path: string,
  body: unknown,
  config: unknown = MULTI,
  vaultSeed: Array<[string, string]> = [],
) {
  const vault = new Map<string, string>(vaultSeed);
  const secretsStore = {
    set: vi.fn((name: string, value: string) => { vault.set(name, value); }),
    delete: vi.fn((name: string) => vault.delete(name)),
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
  return { res, vault, secretsStore, integrations };
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

  it("accepts an omitted non-primary credential", async () => {
    const result = await request("/api/integrations/install", { id: "email", secretValues: { SMTP_PASS: "smtp-secret" } });

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([["SMTP_PASS", "smtp-secret"]]);
  });

  // ── An install that stores nothing never reports success ──

  it("rejects a non-string secretValue instead of silently succeeding", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValue: 12345 }, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Credential GITHUB_TOKEN must be a string" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect([...result.vault]).toEqual([]);
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  // The same guard on the OTHER arm. `secretValues` is the shape the modal
  // actually posts, so this is the arm a real caller reaches; a non-string here
  // is truthy, so the empty check waves it through and a number/object lands in
  // the encrypted vault under a declared name.
  it("rejects a non-string value in the secretValues map instead of vaulting it", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValues: { GITHUB_TOKEN: 12345 } }, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Credential GITHUB_TOKEN must be a string" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect([...result.vault]).toEqual([]);
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("rejects a non-string non-primary value and writes nothing for the valid ones alongside it", async () => {
    // Rejection is whole-body: resolution completes before any write, so the
    // good SMTP_PASS in the same request must not be stored either.
    for (const value of [12345, true, { token: "x" }, ["token"]]) {
      const result = await request("/api/integrations/install", {
        id: "email",
        secretValues: { SMTP_PASS: "smtp-secret", IMAP_PASS: value },
      });

      expect(result.res.statusCode, JSON.stringify(value)).toBe(400);
      expect(JSON.parse(result.res.body)).toEqual({ error: "Credential IMAP_PASS must be a string" });
      expect(result.secretsStore.set).not.toHaveBeenCalled();
      expect([...result.vault]).toEqual([]);
      expect(result.integrations.markInstalled).not.toHaveBeenCalled();
    }
  });

  it("rejects a null secretValue rather than marking the integration connected", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValue: null }, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("rejects an empty secretValue rather than marking the integration connected", async () => {
    const result = await request("/api/integrations/install", { id: "github", secretValue: "" }, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Credential GITHUB_TOKEN must not be empty" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("rejects an install that supplies no credential key at all", async () => {
    const result = await request("/api/integrations/install", { id: "github" }, SINGLE);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Credential GITHUB_TOKEN is required" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  // Replaces a test that asserted an empty map entry was SKIPPED and the
  // install still returned 200 — that pinned the silent-success defect. An
  // explicitly supplied blank is a user error, not an omission, and the modal
  // already refuses to submit one.
  it("rejects an empty value in the secretValues map instead of skipping it", async () => {
    const primary = await request("/api/integrations/install", { id: "github", secretValues: { GITHUB_TOKEN: "" } }, SINGLE);

    expect(primary.res.statusCode).toBe(400);
    expect(JSON.parse(primary.res.body)).toEqual({ error: "Credential GITHUB_TOKEN must not be empty" });
    expect(primary.secretsStore.set).not.toHaveBeenCalled();
    expect(primary.integrations.markInstalled).not.toHaveBeenCalled();

    const secondary = await request("/api/integrations/install", {
      id: "email",
      secretValues: { SMTP_PASS: "smtp-secret", IMAP_PASS: "" },
    });

    expect(secondary.res.statusCode).toBe(400);
    expect(JSON.parse(secondary.res.body)).toEqual({ error: "Credential IMAP_PASS must not be empty" });
    expect(secondary.secretsStore.set).not.toHaveBeenCalled();
    expect(secondary.integrations.markInstalled).not.toHaveBeenCalled();
  });

  it("rejects an install that supplies only a non-primary credential", async () => {
    const result = await request("/api/integrations/install", { id: "email", secretValues: { IMAP_PASS: "imap-secret" } });

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Credential SMTP_PASS is required" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
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

  // ── An integration that declares no credentials has nothing to store ──

  it("connects an integration that declares no credentials at all", async () => {
    const result = await request("/api/integrations/install", { id: "bare" }, NO_CREDENTIALS);

    expect(result.res.statusCode).toBe(200);
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect(result.integrations.markInstalled).toHaveBeenCalledWith("bare", true);
  });

  it("connects a no-credential integration sent an empty secretValues map", async () => {
    const result = await request("/api/integrations/install", { id: "bare", secretValues: {} }, NO_CREDENTIALS);

    expect(result.res.statusCode).toBe(200);
    expect(result.integrations.markInstalled).toHaveBeenCalledWith("bare", true);
  });

  it("refuses to store a value for a no-credential integration rather than writing an unnamed secret", async () => {
    const result = await request("/api/integrations/install", { id: "bare", secretValue: "orphan" }, NO_CREDENTIALS);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Integration declares no credentials" });
    expect(result.secretsStore.set).not.toHaveBeenCalled();
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
  });

  // ── Uninstall deletes the primary credential and nothing else ──

  it("deletes the primary credential on uninstall", async () => {
    const result = await request("/api/integrations/uninstall", { id: "github" }, SINGLE, [["GITHUB_TOKEN", "ghp"]]);

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([]);
    expect(result.secretsStore.delete).toHaveBeenCalledWith("GITHUB_TOKEN");
    expect(result.integrations.markInstalled).toHaveBeenCalledWith("github", false);
  });

  // Known limitation, descoped to C7: no builtin declares a second credential
  // today, so the primary IS the whole install. Asserted so the descope is
  // visible rather than discovered.
  it("leaves a declared non-primary credential alone on uninstall", async () => {
    const result = await request("/api/integrations/uninstall", { id: "email" }, MULTI, [
      ["SMTP_PASS", "smtp-secret"],
      ["IMAP_PASS", "imap-secret"],
    ]);

    expect([...result.vault.keys()]).toEqual(["IMAP_PASS"]);
    expect(result.secretsStore.delete.mock.calls.flat()).toEqual(["SMTP_PASS"]);
  });

  // A declaration is authored over the network (POST /api/integrations accepts
  // any credential list), so uninstall must never widen past the primary: one
  // request would otherwise empty the vault of every key it named.
  it("cannot delete a credential it did not declare as primary", async () => {
    const EVIL = {
      id: "evil",
      name: "Evil",
      secretName: "EVIL_TOKEN",
      credentials: [{ name: "EVIL_TOKEN" }, { name: "ANTHROPIC_API_KEY" }, { name: "GITHUB_TOKEN" }],
    };
    const result = await request("/api/integrations/uninstall", { id: "evil" }, EVIL, [
      ["ANTHROPIC_API_KEY", "sk-ant"],
      ["GITHUB_TOKEN", "ghp"],
    ]);

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault.keys()]).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
    expect(result.secretsStore.delete.mock.calls.flat()).toEqual(["EVIL_TOKEN"]);
  });

  it("deletes nothing when the integration declares no credentials", async () => {
    const result = await request("/api/integrations/uninstall", { id: "bare" }, NO_CREDENTIALS, [["", "junk"]]);

    expect(result.res.statusCode).toBe(200);
    expect(result.secretsStore.delete).not.toHaveBeenCalled();
    expect(result.integrations.markInstalled).toHaveBeenCalledWith("bare", false);
  });

  it("rejects an unparseable uninstall body before touching the registry or the vault", async () => {
    const result = await request("/api/integrations/uninstall", undefined, SINGLE, [["GITHUB_TOKEN", "ghp"]]);

    expect(result.res.statusCode).toBe(400);
    expect(JSON.parse(result.res.body)).toEqual({ error: "Invalid JSON" });
    expect(result.integrations.get).not.toHaveBeenCalled();
    expect(result.secretsStore.delete).not.toHaveBeenCalled();
    expect(result.integrations.markInstalled).not.toHaveBeenCalled();
    expect([...result.vault.keys()]).toEqual(["GITHUB_TOKEN"]);
  });
});
