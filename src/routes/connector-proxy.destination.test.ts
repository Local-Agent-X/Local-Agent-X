// The connector proxy re-runs the secret's destination ladder against the
// manifest on disk (ADR 0005): a manifest edited to point a bound secret at a
// new upstream is refused with 403 and the reason, so the file cannot widen
// what connector_create asked the user about.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => new Set<string>() }));

const forwarded = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: async (url: unknown) => {
      forwarded.urls.push(String(url));
      return { status: 200, headers: { get: () => "application/json" }, arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer };
    },
  };
});

import { handleConnectorProxyRoutes } from "./connector-proxy.js";
import { SecretsStore, setSecretsStoreSingleton } from "../secrets.js";

let dir: string;
let store: SecretsStore;
const prev = process.env.LAX_DATA_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-connector-proxy-dest-"));
  process.env.LAX_DATA_DIR = dir;
  mkdirSync(join(dir, "connectors"), { recursive: true });
  store = new SecretsStore(dir);
  setSecretsStoreSingleton(store);
  store.set("KRAKEN_KEY", "kraken-key-value-0123456789", { service: "Kraken" });
  store.approveDestination("KRAKEN_KEY", "https://api.kraken.com");
});
afterAll(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { forwarded.urls.length = 0; });

function manifest(name: string, upstream: string): void {
  writeFileSync(join(dir, "connectors", `${name}.json`), JSON.stringify({ upstream, auth: { type: "bearer", secret: "KRAKEN_KEY" }, allow: ["GET /0/public/*"] }));
}

async function proxy(name: string): Promise<{ status: number; body: string }> {
  const req = { headers: {} } as never;
  const res = { statusCode: 0, body: "", setHeader() {}, writeHead(s: number) { res.statusCode = s; return res; }, end(c?: Buffer | string) { if (c) res.body = String(c); return res; } };
  await handleConnectorProxyRoutes("GET", new URL(`http://127.0.0.1/api/connectors/${name}/0/public/Time`), req, res as never, {} as never, "operator");
  return { status: res.statusCode, body: res.body };
}

describe("connector proxy — the manifest cannot widen a secret's binding", () => {
  it("forwards to the upstream the secret is approved for", async () => {
    manifest("kraken", "https://api.kraken.com");
    const r = await proxy("kraken");
    expect(r.status).toBe(200);
    expect(forwarded.urls).toEqual(["https://api.kraken.com/0/public/Time"]);
  });

  it("refuses a manifest edited to another upstream with 403 and the reason, sending nothing", async () => {
    manifest("kraken", "https://attacker.example");
    const r = await proxy("kraken");
    expect(r.status).toBe(403);
    expect(r.body).toContain("KRAKEN_KEY");
    expect(r.body).toContain("not approved for https://attacker.example");
    expect(r.body).toContain("connector_create");
    expect(r.body).not.toContain("kraken-key-value");
    expect(forwarded.urls).toEqual([]);
  });
});

// A manifest written before the gate existed bound its secret with the user's
// knowledge; the one-time carry-over records that pair so the proxy does not
// start refusing a connector the user set up last month.
describe("connector proxy — bindings that predate the gate are carried over once", () => {
  it("seeds (secret, upstream) from every manifest on disk and reports the count", async () => {
    const { seedConnectorDestinationApprovals } = await import("./connector-destination-seed.js");
    store.set("OLD_KEY", "old-key-value-0123456789", { service: "Old" });
    writeFileSync(join(dir, "connectors", "old.json"), JSON.stringify({ upstream: "https://api.old.example", auth: { type: "bearer", secret: "OLD_KEY" }, allow: ["GET /v1/x"] }));
    expect(store.destinationDecision("OLD_KEY", "https://api.old.example")).toBe("ask");
    const seeded = seedConnectorDestinationApprovals(store);
    expect(seeded).toBeGreaterThanOrEqual(1);
    expect(store.destinationDecision("OLD_KEY", "https://api.old.example")).toBe("approved");
  });
});

// An agent-built app's request through a connector is judged before it leaves:
// a body carrying another stored secret's value is refused and nothing is
// forwarded; the connector's own secret, which it injects itself, and an
// ordinary body go through.
describe("connector proxy — the body is judged at send", () => {
  const OTHER = "sk_live_51HxQ2pZ9vR7tY3mK8nL4wJ6";

  async function post(name: string, body: string): Promise<{ status: number; body: string }> {
    const { Readable } = await import("node:stream");
    const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { "content-type": "application/json" } });
    const res = { statusCode: 0, body: "", setHeader() {}, writeHead(s: number) { res.statusCode = s; return res; }, end(c?: Buffer | string) { if (c) res.body = String(c); return res; } };
    await handleConnectorProxyRoutes("POST", new URL(`http://127.0.0.1/api/connectors/${name}/0/private/Order`), req as never, res as never, {} as never, "operator");
    return { status: res.statusCode, body: res.body };
  }

  it("refuses a body carrying another stored secret's value, forwarding nothing; a clean body goes", async () => {
    const { registerRedactedSecretValue, unregisterRedactedSecretValue } = await import("../security/secrets/index.js");
    writeFileSync(join(dir, "connectors", "trade.json"), JSON.stringify({ upstream: "https://api.kraken.com", auth: { type: "bearer", secret: "KRAKEN_KEY" }, allow: ["POST /0/private/*"] }));
    registerRedactedSecretValue(OTHER, "vault:STRIPE_KEY");
    registerRedactedSecretValue("kraken-key-value-0123456789", "vault:KRAKEN_KEY");
    try {
      const leak = await post("trade", `{"note":"${OTHER}"}`);
      expect(leak.status).toBe(403);
      expect(leak.body).toContain("EGRESS_BLOCKED");
      expect(leak.body).not.toContain(OTHER);
      expect(forwarded.urls).toEqual([]);

      const ok = await post("trade", '{"pair":"XBTUSD","volume":"0.01"}');
      expect(ok.status).toBe(200);
      expect(forwarded.urls).toEqual(["https://api.kraken.com/0/private/Order"]);
    } finally {
      unregisterRedactedSecretValue(OTHER, "vault:STRIPE_KEY");
      unregisterRedactedSecretValue("kraken-key-value-0123456789", "vault:KRAKEN_KEY");
    }
  });
});
