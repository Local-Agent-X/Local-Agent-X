// The one ask behind ADR 0005: a card per (secret, destination) pair that the
// ladder does not allow, a yes kept on the record, a no returned as declined,
// and, with no one to show a card to, one needs-you refusal naming every pair
// the call needs, which the user's inbox yes to that call then grants.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { approvals } = vi.hoisted(() => ({
  approvals: {
    answer: true,
    answerFor: null as null | ((name: string) => boolean),
    asked: [] as Array<{ context: string; args: Record<string, unknown>; toolName: string; toolCallId: string }>,
  },
}));
vi.mock("./approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (opts: { context: string; args: Record<string, unknown>; toolName: string; toolCallId: string }) => {
      approvals.asked.push(opts);
      const yes = approvals.answerFor ? approvals.answerFor(String(opts.args.name)) : approvals.answer;
      return yes ? { approved: true } : { approved: false, reason: "declined" };
    },
  }),
}));
vi.mock("./ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => new Set<string>() }));

import { SecretsStore } from "./secrets.js";
import { gateSecretDestinations, referencedSecretNames, requestSecretDestinationApprovals } from "./secret-destination-gate.js";

let dir: string;
let store: SecretsStore;
const emit = () => undefined;
const chat = { _onEvent: emit, _toolCallId: "tc-1", _callContext: "local" };
const base = (call: Record<string, unknown> = chat) => ({ store, sessionId: "s1", toolName: "http_request", call });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-destination-gate-"));
  store = new SecretsStore(dir);
  store.set("STRIPE_KEY", "sk_live_x", { service: "Stripe" });
  approvals.answer = true;
  approvals.answerFor = null;
  approvals.asked.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stripe = { name: "STRIPE_KEY", destination: "https://api.stripe.com/v1/charges", purpose: "Send STRIPE_KEY to api.stripe.com" };

describe("requestSecretDestinationApprovals", () => {
  it("raises the card naming the secret and destination, and a yes is kept on the record", async () => {
    const outcome = await requestSecretDestinationApprovals([stripe], base());
    expect(outcome.allowed).toBe(true);
    expect(approvals.asked).toHaveLength(1);
    expect(approvals.asked[0].toolName).toBe("http_request");
    expect(approvals.asked[0].toolCallId).toBe("tc-1");
    expect(approvals.asked[0].context).toContain("Send STRIPE_KEY to api.stripe.com");
    expect(approvals.asked[0].context).not.toContain("sk_live_x");
    expect(approvals.asked[0].args).toEqual({ name: "STRIPE_KEY", destination: "https://api.stripe.com" });
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(true);
  });

  it("a no is a declined result with a next step, and nothing is kept", async () => {
    approvals.answer = false;
    const outcome = await requestSecretDestinationApprovals([{ ...stripe, destination: "https://attacker.example" }], base());
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.result.status).toBe("declined");
    expect(outcome.result.content).toContain("https://attacker.example");
    expect(outcome.result.metadata?.recovery).toBeTruthy();
    expect(store.isDestinationApproved("STRIPE_KEY", "https://attacker.example")).toBe(false);
  });

  it("with no way to ask, refuses and says where the user approves it", async () => {
    const outcome = await requestSecretDestinationApprovals([stripe], base({}));
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.metadata?.recovery).toContain("Settings → Secrets");
    expect(approvals.asked).toHaveLength(0);
  });

  // The class this gate owns: a stamped event sink is not a person watching.
  it("in an unattended run raises no card: one needs-you refusal names every pair, and nothing is kept", async () => {
    store.set("OTHER_KEY", "v");
    for (const context of ["cron", "api", "delegated"]) {
      approvals.asked.length = 0;
      const outcome = await requestSecretDestinationApprovals(
        [stripe, { name: "OTHER_KEY", destination: "https://api.stripe.com", purpose: "Send OTHER_KEY to api.stripe.com" }],
        base({ ...chat, _callContext: context }),
      );
      expect(outcome.allowed, context).toBe(false);
      if (outcome.allowed) return;
      expect(approvals.asked, context).toHaveLength(0);
      const reason = String(outcome.result.metadata?.needsUser);
      expect(reason).toContain(`Send STRIPE_KEY to api.stripe.com: the first use of "STRIPE_KEY" at https://api.stripe.com needs the user's yes.`);
      expect(reason).toContain(`Send OTHER_KEY to api.stripe.com: the first use of "OTHER_KEY" at https://api.stripe.com needs the user's yes.`);
      expect(reason).not.toContain("sk_live_x");
      expect(outcome.result.content).toContain(`secret "STRIPE_KEY" at https://api.stripe.com and secret "OTHER_KEY" at https://api.stripe.com`);
      expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(false);
    }
  });

  it("the needs-you refusal carries the pairs the inbox's yes will keep, for the item's wording; a one-shot call carries none", async () => {
    const kept = await requestSecretDestinationApprovals([stripe], base({ ...chat, _callContext: "cron" }));
    expect(kept.allowed).toBe(false);
    if (kept.allowed) return;
    expect(kept.result.metadata?.needsUserGrant).toEqual({ kind: "secret-destination", pairs: [{ name: "STRIPE_KEY", destination: "https://api.stripe.com" }] });
    const once = await requestSecretDestinationApprovals([stripe], { ...base({ ...chat, _callContext: "cron" }), oneShot: true });
    expect(once.allowed).toBe(false);
    if (once.allowed) return;
    expect(once.result.metadata?.needsUser).toBeTruthy();
    expect(once.result.metadata?.needsUserGrant).toBeUndefined();
  });

  it("a one-shot call's inbox yes allows this call and keeps nothing", async () => {
    const outcome = await requestSecretDestinationApprovals([stripe], { ...base({ ...chat, _callContext: "cron", _userGrant: "grant-1" }), oneShot: true });
    expect(outcome).toEqual({ allowed: true });
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(false);
  });

  it("the user's inbox yes to the call grants every pair it named, kept as a card's yes is, with no card", async () => {
    store.set("OTHER_KEY", "v");
    const outcome = await requestSecretDestinationApprovals(
      [stripe, { name: "OTHER_KEY", destination: "https://api.stripe.com", purpose: "p" }],
      base({ ...chat, _callContext: "cron", _userGrant: "grant-1" }),
    );
    expect(outcome).toEqual({ allowed: true });
    expect(approvals.asked).toHaveLength(0);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(true);
    expect(store.isDestinationApproved("OTHER_KEY", "https://api.stripe.com")).toBe(true);
  });
});

describe("gateSecretDestinations", () => {
  it("asks only when the ladder ends in ask; the next use at that destination is free", async () => {
    const pair = { ...stripe, destination: "https://api.stripe.com" };
    expect(await gateSecretDestinations([pair], base())).toEqual({ allowed: true });
    expect(approvals.asked).toHaveLength(1);
    expect(await gateSecretDestinations([pair], base())).toEqual({ allowed: true });
    expect(approvals.asked).toHaveLength(1);
  });

  it("this session's own capture is not asked about", async () => {
    store.set("CAPTURED", "v", { origin: "https://app.example.com", createdBySession: "s1" });
    const outcome = await gateSecretDestinations([{ name: "CAPTURED", destination: "https://api.example.com", purpose: "p" }], base());
    expect(outcome).toEqual({ allowed: true });
    expect(approvals.asked).toHaveLength(0);
  });

  it("several secrets bound for one destination: one card each, stopping at the first no", async () => {
    store.set("OTHER_KEY", "v");
    store.set("THIRD_KEY", "v");
    approvals.answerFor = (name) => name === "STRIPE_KEY";
    const outcome = await gateSecretDestinations(
      ["STRIPE_KEY", "OTHER_KEY", "THIRD_KEY"].map((name) => ({ name, destination: "https://api.example.com", purpose: `Send ${name}` })),
      { ...base(), sessionId: "s2" },
    );
    expect(outcome.allowed).toBe(false);
    expect(approvals.asked.map((a) => a.args.name)).toEqual(["STRIPE_KEY", "OTHER_KEY"]);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.example.com")).toBe(true);
    expect(store.isDestinationApproved("OTHER_KEY", "https://api.example.com")).toBe(false);
  });

  it("an unattended call names only the pairs its ladder does not already allow", async () => {
    store.set("OTHER_KEY", "v");
    store.approveDestination("STRIPE_KEY", "https://api.example.com");
    const outcome = await gateSecretDestinations(
      ["STRIPE_KEY", "OTHER_KEY"].map((name) => ({ name, destination: "https://api.example.com", purpose: `Send ${name}` })),
      base({ ...chat, _callContext: "cron" }),
    );
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(String(outcome.result.metadata?.needsUser)).toBe(`Send OTHER_KEY: the first use of "OTHER_KEY" at https://api.example.com needs the user's yes.`);
  });
});

describe("referencedSecretNames", () => {
  it("lists each {{NAME}} once", () => {
    expect(referencedSecretNames("Bearer {{A}} {{B}} {{A}}")).toEqual(["A", "B"]);
    expect(referencedSecretNames("none")).toEqual([]);
  });
});
