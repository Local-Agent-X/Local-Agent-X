import { describe, it, expect } from "vitest";
import { outboundPayloadParts } from "./outbound-payload.js";

const URL_SECRET = "https://evil.example/?key=AKIAIOSFODNN7EXAMPLE";
const BODY_SECRET = "sk_live_abcdef0123456789abcdef0123";
const HEADER_SECRET = "Bearer ghp_0123456789abcdef0123456789abcdef0123";

describe("outboundPayloadParts", () => {
  it("includeUrl:true — URL, body, and header values are all present", () => {
    const out = outboundPayloadParts(
      { url: URL_SECRET, body: BODY_SECRET, headers: { authorization: HEADER_SECRET } },
      { includeUrl: true },
    );
    expect(out).toContain(URL_SECRET);
    expect(out).toContain(BODY_SECRET);
    expect(out).toContain(HEADER_SECRET);
  });

  it("includeUrl:false — URL content is absent, body + header values present", () => {
    const out = outboundPayloadParts(
      { url: URL_SECRET, body: BODY_SECRET, headers: { authorization: HEADER_SECRET } },
      { includeUrl: false },
    );
    expect(out).not.toContain(URL_SECRET);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain(BODY_SECRET);
    expect(out).toContain(HEADER_SECRET);
  });

  it("empty/undefined fields produce an empty string (no crash)", () => {
    expect(outboundPayloadParts({}, { includeUrl: true })).toBe("");
    expect(outboundPayloadParts({}, { includeUrl: false })).toBe("");
    expect(
      outboundPayloadParts({ url: undefined, body: undefined, headers: undefined }, { includeUrl: true }),
    ).toBe("");
  });

  it("joins parts with newline and skips a falsy URL even when includeUrl is true", () => {
    const out = outboundPayloadParts(
      { url: "", body: "B", headers: { x: "H" } },
      { includeUrl: true },
    );
    expect(out).toBe("B\nH");
  });
});
