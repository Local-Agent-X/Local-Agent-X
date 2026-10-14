// The one ask behind ADR 0005: a card per (secret, destination) pair that the
// ladder does not allow, a yes kept on the record, a no returned as declined,
// and a refusal that names Settings when there is no way to ask.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { approvals } = vi.hoisted(() => ({
  approvals: {
    answer: true,
    answerFor: null as null | ((name: string) => boolean),
    asked: [] as Array<{ context: string; args: Record<string, unknown>; toolName: string }>,
  },
}));
vi.mock("./approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (opts: { context: string; args: Record<string, unknown>; toolName: string }) => {
      approvals.asked.push(opts);
      const yes = approvals.answerFor ? approvals.answerFor(String(opts.args.name)) : approvals.answer;
      return yes ? { approved: true } : { approved: false, reason: "declined" };
    },
  }),
}));
vi.mock("./ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => new Set<string>() }));

import { SecretsStore } from "./secrets.js";
import { gateSecretDestination, gateSecretDestinations, referencedSecretNames, requestSecretDestinationApproval } from "./secret-destination-gate.js";

let dir: string;
let store: SecretsStore;
const emit = () => undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-destination-gate-"));
  store = new SecretsStore(dir);
  store.set("STRIPE_KEY", "sk_live_x", { service: "Stripe" });
  approvals.answer = true;
  approvals.answerFor = null;
  approvals.asked.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("requestSecretDestinationApproval", () => {
  it("raises the card naming the secret and destination, and a yes is kept on the record", async () => {
    const outcome = await requestSecretDestinationApproval({
      store, name: "STRIPE_KEY", destination: "https://api.stripe.com/v1/charges", purpose: "Send STRIPE_KEY to api.stripe.com",
      sessionId: "s1", toolName: "http_request", toolCallId: "tc-1", onEvent: emit,
    });
    expect(outcome.allowed).toBe(true);
    expect(approvals.asked).toHaveLength(1);
    expect(approvals.asked[0].toolName).toBe("http_request");
    expect(approvals.asked[0].context).toContain("Send STRIPE_KEY to api.stripe.com");
    expect(approvals.asked[0].context).not.toContain("sk_live_x");
    expect(approvals.asked[0].args).toEqual({ name: "STRIPE_KEY", destination: "https://api.stripe.com" });
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.stripe.com")).toBe(true);
  });

  it("a no is a declined result with a next step, and nothing is kept", async () => {
    approvals.answer = false;
    const outcome = await requestSecretDestinationApproval({
      store, name: "STRIPE_KEY", destination: "https://attacker.example", purpose: "Send STRIPE_KEY to attacker.example",
      sessionId: "s1", toolName: "http_request", onEvent: emit,
    });
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.result.status).toBe("declined");
    expect(outcome.result.content).toContain("https://attacker.example");
    expect(outcome.result.metadata?.recovery).toBeTruthy();
    expect(store.isDestinationApproved("STRIPE_KEY", "https://attacker.example")).toBe(false);
  });

  it("with no way to ask, refuses and says where the user approves it", async () => {
    const outcome = await requestSecretDestinationApproval({
      store, name: "STRIPE_KEY", destination: "https://api.stripe.com", purpose: "p", sessionId: "s1", toolName: "http_request",
    });
    expect(outcome.allowed).toBe(false);
    if (outcome.allowed) return;
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.metadata?.recovery).toContain("Settings → Secrets");
    expect(approvals.asked).toHaveLength(0);
  });
});

describe("gateSecretDestination(s)", () => {
  it("asks only when the ladder ends in ask; the next use at that destination is free", async () => {
    const ask = { store, name: "STRIPE_KEY", destination: "https://api.stripe.com", purpose: "p", sessionId: "s1", toolName: "http_request", onEvent: emit };
    expect(await gateSecretDestination(ask)).toEqual({ allowed: true, decision: "approved" });
    expect(approvals.asked).toHaveLength(1);
    expect(await gateSecretDestination(ask)).toEqual({ allowed: true, decision: "approved" });
    expect(approvals.asked).toHaveLength(1);
  });

  it("this session's own capture is not asked about", async () => {
    store.set("CAPTURED", "v", { origin: "https://app.example.com", createdBySession: "s1" });
    const outcome = await gateSecretDestination({ store, name: "CAPTURED", destination: "https://api.example.com", purpose: "p", sessionId: "s1", toolName: "http_request", onEvent: emit });
    expect(outcome).toEqual({ allowed: true, decision: "session" });
    expect(approvals.asked).toHaveLength(0);
  });

  it("several secrets bound for one destination: one card each, stopping at the first no", async () => {
    store.set("OTHER_KEY", "v");
    store.set("THIRD_KEY", "v");
    approvals.answerFor = (name) => name === "STRIPE_KEY";
    const outcome = await gateSecretDestinations(["STRIPE_KEY", "OTHER_KEY", "THIRD_KEY"], {
      store, destination: "https://api.example.com", sessionId: "s2", toolName: "http_request", onEvent: emit, purpose: (n) => `Send ${n}`,
    });
    expect(outcome.allowed).toBe(false);
    expect(approvals.asked.map((a) => a.args.name)).toEqual(["STRIPE_KEY", "OTHER_KEY"]);
    expect(store.isDestinationApproved("STRIPE_KEY", "https://api.example.com")).toBe(true);
    expect(store.isDestinationApproved("OTHER_KEY", "https://api.example.com")).toBe(false);
  });
});

describe("referencedSecretNames", () => {
  it("lists each {{NAME}} once", () => {
    expect(referencedSecretNames("Bearer {{A}} {{B}} {{A}}")).toEqual(["A", "B"]);
    expect(referencedSecretNames("none")).toEqual([]);
  });
});
