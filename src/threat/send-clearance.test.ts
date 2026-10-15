// A send the outbound guard let through for the user's own reasons (a trusted
// destination, or the user's yes on its card) is audited after it runs, never
// scored as exfiltration: the engine takes the guard's verdict instead of
// re-judging what the user chose.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreatEngine } from "./threat-engine.js";
import { getLaxDir } from "../lax-data-dir.js";
import { checkOutboundEmail, checkOutboundPayload, checkOutboundRequest, isTrustedSend } from "../tools/http-egress-guard.js";

const SECRET = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const allowlist = join(getLaxDir(), "egress-allowlist.json");

beforeAll(() => {
  mkdirSync(getLaxDir(), { recursive: true });
  writeFileSync(allowlist, JSON.stringify(["api.trusted.example", "trusted.example"]));
});
afterAll(() => rmSync(allowlist, { force: true }));

let seq = 0;
function freshEngine(): ThreatEngine {
  seq += 1;
  return new ThreatEngine(join(tmpdir(), `lax-send-clearance-${process.pid}-${seq}`), `sess-clear-${seq}`);
}

const email = (to: string, cc = "") => ({ to, cc, subject: "token", body: `use ${SECRET}` });

describe("isTrustedSend says what the outbound guard decided", () => {
  it("an http request is trusted exactly when the guard passes its secret for the destination", () => {
    for (const url of ["https://api.trusted.example/v1", "https://evil.example/v1"]) {
      const passed = checkOutboundRequest({ url, method: "POST", body: SECRET }) === null;
      expect(isTrustedSend("http_request", { url, body: SECRET }), url).toBe(passed);
      expect(isTrustedSend("ari_http", { url, body: SECRET }), url).toBe(passed);
    }
    expect(isTrustedSend("http_request", { url: "https://api.trusted.example/v1" })).toBe(true);
  });

  it("an email is trusted exactly when the guard passes its secret for every recipient", () => {
    for (const args of [email("boss@trusted.example"), email("boss@trusted.example", "x@evil.example"), email("x@evil.example")]) {
      const passed = checkOutboundEmail(args, args.body) === null;
      expect(isTrustedSend("email_send", args), JSON.stringify(args)).toBe(passed);
    }
  });

  it("a channel with no allowlist is never trusted, as the guard refuses its secrets everywhere", () => {
    expect(checkOutboundPayload("web_fetch", `https://api.trusted.example/?k=${SECRET}`)).not.toBeNull();
    expect(isTrustedSend("web_fetch", { url: "https://api.trusted.example/" })).toBe(false);
    expect(isTrustedSend("clipboard_write", { text: SECRET })).toBe(false);
  });
});

describe("ThreatEngine takes the guard's verdict on a send the user chose", () => {
  it("scores a secret sent to a stranger the user did not approve", () => {
    const engine = freshEngine();
    const res = engine.evaluateToolResult("email_send", email("x@evil.example"), "sent", true);
    expect(res.blocked).toBe(true);
  });

  it("audits, but does not score, a send the user approved on its card", () => {
    const engine = freshEngine();
    const res = engine.evaluateToolResult("email_send", email("x@evil.example"), "sent", true, { trustedDestination: false, approvedByUser: true });
    expect(res.blocked).toBe(false);
    expect(engine.isRestricted()).toBe(false);
    expect(engine.scorer.getRawLoad()).toBe(0);
    const audited = engine.audit.getRecent(50).filter((e) => e.event === "exfiltration_allowed_by_consent");
    expect(audited.map((e) => e.reason).join("\n")).toContain("user-approved-send");
  });

  it("audits, but does not score, a send to a destination the user trusts", () => {
    const engine = freshEngine();
    const args = { url: "https://api.trusted.example/v1", method: "POST", body: SECRET };
    const res = engine.evaluateToolResult("http_request", args, "ok", true, { trustedDestination: isTrustedSend("http_request", args), approvedByUser: false });
    expect(res.blocked).toBe(false);
    expect(engine.scorer.getRawLoad()).toBe(0);
    expect(engine.audit.getRecent(50).some((e) => e.event === "exfiltration_allowed_by_consent" && e.reason?.includes("trusted-destination"))).toBe(true);
  });
});
