import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The secret destination card (secret-destination-gate.ts), answered by the test.
const { approvals } = vi.hoisted(() => ({ approvals: { answer: true, asked: [] as Array<{ context: string; args: Record<string, unknown> }> } }));
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (opts: { context: string; args: Record<string, unknown> }) => {
      approvals.asked.push(opts);
      return approvals.answer ? { approved: true } : { approved: false, reason: "declined" };
    },
  }),
}));
vi.mock("../ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => new Set<string>() }));

import { connectorCreateTool } from "./connector-tools.js";
import { parseManifest } from "../routes/connector-proxy.js";
import { SecretsStore, setSecretsStoreSingleton } from "../secrets.js";
import { parkNeedsUser } from "../tool-execution/deferred-call.js";
import { inboxStore } from "../inbox/index.js";
import { declineInboxItem } from "../inbox/approvals.js";
import type { ToolCallContext } from "../tool-execution/context.js";

let dir: string;
let store: SecretsStore;
const prev = process.env.LAX_DATA_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-connectors-test-"));
  process.env.LAX_DATA_DIR = dir;
  store = new SecretsStore(dir);
  setSecretsStoreSingleton(store);
});
afterAll(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { approvals.answer = true; approvals.asked.length = 0; });

function run(args: Record<string, unknown>): Promise<{ content: string; isError?: boolean; status?: string }> {
  return connectorCreateTool.execute!({ _sessionId: "chat-1", _onEvent: () => undefined, _callContext: "local", ...args }) as Promise<{ content: string; isError?: boolean; status?: string }>;
}

describe("connector_create", () => {
  it("writes a keyless connector the proxy can load back", async () => {
    const r = await run({ name: "coingecko", upstream: "https://api.coingecko.com", auth: { type: "none" }, allow: ["GET /api/v3/simple/price"] });
    expect(r.isError).toBeFalsy();
    const file = join(dir, "connectors", "coingecko.json");
    expect(existsSync(file)).toBe(true);
    expect(parseManifest(readFileSync(file, "utf-8")).ok).toBe(true);
    expect(r.content).toContain("/api/connectors/coingecko/<path>");
  });

  it("defaults auth to none when omitted", async () => {
    const r = await run({ name: "publicapi", upstream: "https://api.example.com", allow: ["GET /v1/data"] });
    expect(r.isError).toBeFalsy();
  });

  it("rejects an invalid manifest (non-https upstream) via parseManifest", async () => {
    const r = await run({ name: "bad", upstream: "ftp://nope", allow: ["GET /x"] });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/upstream/);
  });

  it("rejects a non-slug name and writes nothing", async () => {
    const r = await run({ name: "Bad Name", upstream: "https://api.example.com", allow: ["GET /x"] });
    expect(r.isError).toBe(true);
    expect(existsSync(join(dir, "connectors", "Bad Name.json"))).toBe(false);
  });

  it("warns when a bearer connector references an unstored secret", async () => {
    const r = await run({ name: "needskey", upstream: "https://api.example.com", auth: { type: "bearer", secret: "EXAMPLE_TOKEN_DEFINITELY_UNSET" }, allow: ["GET /me"] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/not stored yet/);
    expect(approvals.asked).toHaveLength(0);
  });
});

// A manifest binds a vault secret to an upstream: that is a destination the
// secret's ladder must allow (ADR 0005), asked once and kept.
describe("connector_create — binding a stored secret to an upstream", () => {
  it("asks the user once, naming the upstream, and the approval is kept on the secret", async () => {
    store.set("KRAKEN_KEY", "kraken-key-value-0123456789", { service: "Kraken" });
    const r = await run({ name: "kraken", upstream: "https://api.kraken.com", auth: { type: "bearer", secret: "KRAKEN_KEY" }, allow: ["GET /0/public/*"] });
    expect(r.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(1);
    expect(approvals.asked[0].context).toContain("Send KRAKEN_KEY to https://api.kraken.com");
    expect(approvals.asked[0].context).not.toContain("kraken-key-value");
    expect(store.isDestinationApproved("KRAKEN_KEY", "https://api.kraken.com")).toBe(true);

    const again = await run({ name: "kraken2", upstream: "https://api.kraken.com", auth: { type: "bearer", secret: "KRAKEN_KEY" }, allow: ["GET /0/public/*"] });
    expect(again.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(1);
  });

  it("a no writes no manifest and keeps nothing", async () => {
    store.set("STRIPE_KEY", "stripe-key-value-0123456789", { service: "Stripe" });
    approvals.answer = false;
    const r = await run({ name: "exfil", upstream: "https://attacker.example", auth: { type: "bearer", secret: "STRIPE_KEY" }, allow: ["POST /collect"] });
    expect(r.status).toBe("declined");
    expect(existsSync(join(dir, "connectors", "exfil.json"))).toBe(false);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://attacker.example")).toBe(false);
  });

  it("a secret this session captured is bound without asking", async () => {
    store.set("CAPTURED_KEY", "captured-key-value-0123456789", { origin: "https://app.example.com", createdBySession: "chat-1" });
    const r = await run({ name: "captured", upstream: "https://api.example.com", auth: { type: "header", header: "X-Api-Key", secret: "CAPTURED_KEY" }, allow: ["GET /v1/*"] });
    expect(r.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(0);
  });
});

// A scheduled job defining a connector: nobody is watching, so binding a
// stored secret to a new upstream raises no card. The pipeline parks the call
// in the user's inbox (parkNeedsUser, as run-sandboxed.ts does), and the
// user's yes there is what writes the manifest and keeps the pair.
describe("connector_create — in an unattended run", () => {
  const SESSION = "cron-markets-1700000000000";
  const manifest = { name: "coinbase", upstream: "https://api.coinbase.com", auth: { type: "bearer", secret: "COINBASE_KEY" }, allow: ["GET /v2/prices/*"] };
  const cronRun = (stamps: Record<string, unknown> = {}) =>
    connectorCreateTool.execute!({ _sessionId: SESSION, _onEvent: () => undefined, _callContext: "cron", ...manifest, ...stamps });
  const park = (result: Awaited<ReturnType<typeof cronRun>>) => parkNeedsUser({
    tc: { id: "tc-cron", name: "connector_create", arguments: JSON.stringify(manifest) },
    args: { ...manifest }, sessionId: SESSION, callContext: "cron", msgs: [],
  } as unknown as ToolCallContext, result);
  const file = () => join(dir, "connectors", "coinbase.json");
  beforeEach(() => {
    store.set("COINBASE_KEY", "coinbase-key-value-0123456789", { service: "Coinbase" });
    store.revokeDestinationApproval("COINBASE_KEY", "https://api.coinbase.com");
    rmSync(file(), { force: true });
    rmSync(join(dir, "inbox.json"), { force: true });
  });

  it("raises no card and parks the call in the user's inbox; no manifest is written", async () => {
    const r = await cronRun();
    expect(approvals.asked).toHaveLength(0);
    expect(existsSync(file())).toBe(false);
    expect(String(r.metadata?.needsUser)).toContain(`the first use of "COINBASE_KEY" at https://api.coinbase.com needs the user's yes`);
    const parked = park(r);
    const items = inboxStore().list().filter((i) => i.kind === "approval");
    expect(items).toHaveLength(1);
    expect(items[0].deferredCall).toMatchObject({ toolName: "connector_create", args: manifest, callContext: "cron" });
    expect(parked.metadata).toMatchObject({ layer: "approval", deferredTo: items[0].id });
    expect(parked.content).not.toContain("coinbase-key-value");
  });

  it("the user's yes from the inbox writes the manifest on the re-run and keeps the pair", async () => {
    const r = await cronRun({ _userGrant: "grant-1" });
    expect(r.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(0);
    expect(existsSync(file())).toBe(true);
    expect(store.isDestinationApproved("COINBASE_KEY", "https://api.coinbase.com")).toBe(true);
  });

  it("a declined call stays refused: the next run writes nothing and waits on the user again", async () => {
    const item = park(await cronRun()).metadata?.deferredTo as string;
    expect(declineInboxItem(item)).toMatchObject({ ok: true, resolution: "declined" });
    const again = await cronRun();
    expect(again.metadata?.needsUser).toBeTruthy();
    expect(approvals.asked).toHaveLength(0);
    expect(existsSync(file())).toBe(false);
    expect(store.isDestinationApproved("COINBASE_KEY", "https://api.coinbase.com")).toBe(false);
  });
});
