import { describe, it, expect } from "vitest";
import { deriveConnectorCapability, authorizeAppConnectorHttp } from "./app-connector-auth.js";

const OP = "operator-token-abc123";
const CAP = deriveConnectorCapability(OP);

describe("deriveConnectorCapability", () => {
  it("is deterministic", () => {
    expect(deriveConnectorCapability(OP)).toBe(deriveConnectorCapability(OP));
  });
  it("is a distinct value from the operator token (never echo it back)", () => {
    expect(CAP).not.toBe(OP);
    expect(CAP).not.toContain(OP);
  });
  it("rotates with the operator token", () => {
    expect(deriveConnectorCapability("other-operator-token")).not.toBe(CAP);
  });
});

describe("authorizeAppConnectorHttp", () => {
  it("admits the capability for a connector path", () => {
    expect(authorizeAppConnectorHttp(CAP, "/api/connectors/webull/openapi/account/list", OP)).toBe(true);
  });
  it("admits the capability for the connector root prefix", () => {
    expect(authorizeAppConnectorHttp(CAP, "/api/connectors/x", OP)).toBe(true);
  });

  // Regression: the whole point is least privilege — the cap must reach the
  // connector surface and NOTHING else. If any of these flip to true the
  // sandbox is broken.
  it("rejects the capability for every non-connector /api path", () => {
    for (const p of ["/api/bash", "/api/secrets", "/api/self_edit", "/api/memory/save", "/api/settings", "/api/connectors"]) {
      expect(authorizeAppConnectorHttp(CAP, p, OP)).toBe(false);
    }
  });

  it("rejects the operator token presented as the capability", () => {
    expect(authorizeAppConnectorHttp(OP, "/api/connectors/webull/x", OP)).toBe(false);
  });
  it("rejects a capability derived from a different operator token", () => {
    const stale = deriveConnectorCapability("rotated-away");
    expect(authorizeAppConnectorHttp(stale, "/api/connectors/webull/x", OP)).toBe(false);
  });
  it("rejects empty token or empty operator token", () => {
    expect(authorizeAppConnectorHttp("", "/api/connectors/webull/x", OP)).toBe(false);
    expect(authorizeAppConnectorHttp(CAP, "/api/connectors/webull/x", "")).toBe(false);
  });
});
