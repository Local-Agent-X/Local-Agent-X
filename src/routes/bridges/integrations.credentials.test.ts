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

  it("deletes every declared credential on uninstall, not just the primary", async () => {
    const result = await request("/api/integrations/uninstall", { id: "email" }, MULTI, [
      ["SMTP_PASS", "smtp-secret"],
      ["IMAP_PASS", "imap-secret"],
    ]);

    expect(result.res.statusCode).toBe(200);
    expect([...result.vault]).toEqual([]);
    expect(result.secretsStore.delete).toHaveBeenCalledWith("IMAP_PASS");
    expect(result.integrations.markInstalled).toHaveBeenCalledWith("email", false);
  });
});
