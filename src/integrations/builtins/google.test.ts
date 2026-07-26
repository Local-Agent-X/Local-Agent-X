/**
 * google is narrowed to an api-key-honest scope.
 *
 * The finding: it declared `authType: "api_key"` while 5 of its 6 endpoints
 * were user-scoped Gmail/Calendar/Drive paths that only an OAuth2 user grant
 * can reach. Resolved with no OAuth2 — the DECLARATION shrank to what the key
 * satisfies. These tests pin the invariant that survives that decision: every
 * endpoint google declares must be reachable by the auth it declares, so
 * C4's feasibility filter has nothing left to hide.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { googleIntegration } from "./google.js";
import { canAuthTypeReach } from "../types.js";
import { IntegrationRegistry } from "../registry.js";
import type { SecretAvailabilityPort } from "../../credentials/requirements.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-google-integration-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const vault = (...names: string[]): SecretAvailabilityPort => ({ has: (name) => names.includes(name) });

const USER_SCOPED_PATHS = [
  "/gmail/v1/users/me/messages",
  "/gmail/v1/users/me/messages/send",
  "/calendar/v3/calendars/primary/events",
  "/drive/v3/files",
];

describe("google declares only what an api_key can reach", () => {
  it("keeps every declared endpoint reachable by its own auth type", () => {
    expect(googleIntegration.endpoints.length).toBeGreaterThan(0);
    for (const endpoint of googleIntegration.endpoints) {
      expect(
        canAuthTypeReach(googleIntegration.authType, endpoint),
        `${endpoint.method} ${endpoint.path} is declared but unreachable with ${googleIntegration.authType}`,
      ).toBe(true);
    }
  });

  it("declares the YouTube endpoint and none of the user-context ones", () => {
    const paths = googleIntegration.endpoints.map(e => e.path);
    expect(paths).toContain("/youtube/v3/search");
    for (const path of USER_SCOPED_PATHS) {
      expect(paths, `${path} needs a user grant this integration cannot obtain`).not.toContain(path);
    }
  });

  it("declares no OAuth2 scopes, because an api_key grants none", () => {
    // The old list was gmail.modify / calendar / drive — scopes this auth type
    // provably cannot obtain. Trimming it to a shorter false list would be the
    // same bug; the honest value is none.
    expect(googleIntegration.scopes ?? []).toEqual([]);
  });

  it("keeps the persisted id and credential name so existing installs survive", () => {
    // `id` is the key in ~/.lax/integrations.json and GOOGLE_API_KEY is a live
    // vault entry. Narrowing the CLAIMS must never orphan either.
    expect(googleIntegration.id).toBe("google");
    expect(googleIntegration.credentials.map(c => c.name)).toEqual(["GOOGLE_API_KEY"]);
  });

  it("says nothing about Gmail, Calendar or Drive in its user-facing prose", () => {
    const prose = `${googleIntegration.name} ${googleIntegration.description} ${googleIntegration.authInstructions}`;
    for (const claim of ["Gmail", "Calendar", "Drive"]) {
      expect(prose, `still advertises ${claim}`).not.toContain(claim);
    }
  });

  it("declares where the key rides, since the API rejects a bearer token", () => {
    // This is what lets the test route and http_request authenticate without
    // either of them knowing the string "google".
    expect(googleIntegration.headers).toEqual({ "X-Goog-Api-Key": "{{GOOGLE_API_KEY}}" });
  });
});

describe("agent context for an installed google", () => {
  it("advertises YouTube and no Gmail/Calendar/Drive path", () => {
    const registry = new IntegrationRegistry(dir, vault("GOOGLE_API_KEY"));
    registry.markInstalled("google", true);

    const ctx = registry.getAgentContext();
    expect(ctx).toContain("(google)");
    expect(ctx).toContain("- GET /youtube/v3/search");
    for (const path of USER_SCOPED_PATHS) {
      expect(ctx, `${path} must not be advertised`).not.toContain(path);
    }
  });

  it("teaches the model the header its key belongs in", () => {
    const registry = new IntegrationRegistry(dir, vault("GOOGLE_API_KEY"));
    registry.markInstalled("google", true);

    expect(registry.getAgentContext()).toContain('Extra headers: {"X-Goog-Api-Key":"{{GOOGLE_API_KEY}}"}');
  });

  it("leaves the feasibility filter a no-op — nothing is dropped from google", () => {
    // The hard constraint: after the narrowing, the reachability filter can no
    // longer be what makes google's advertisement honest, because there is
    // nothing left for it to remove.
    const registry = new IntegrationRegistry(dir, vault("GOOGLE_API_KEY"));
    registry.markInstalled("google", true);

    const advertised = registry.getAgentContext()
      .split("\n")
      .filter(line => line.startsWith("- GET ") || line.startsWith("- POST "));
    expect(advertised).toHaveLength(googleIntegration.endpoints.length);
  });
});
