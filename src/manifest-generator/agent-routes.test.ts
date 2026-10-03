import { describe, expect, it, vi } from "vitest";

vi.mock("./scanners.js", () => ({
  scanPages: () => [],
  scanSettingsTabs: () => [],
  scanAgentTabs: () => [],
  scanTools: () => [],
  scanApps: () => [],
  scanConfigFiles: () => [],
}));

import { generateManifest } from "./generator.js";
import { scanApiRoutes } from "./route-scanner.js";
import { checkEndpointAccess } from "../rbac.js";
import { AGENT_DENIED_ROUTES, endpointUnder } from "../rbac-agent-denials.js";

// The App Map is what the agent reads to find its way around its own app, so
// a route its self-calls are refused on only sends it into a dead end.
describe("the App Map leaves out the routes the agent is refused on", () => {
  const scanned = scanApiRoutes();
  const mapped = generateManifest().apiRoutes;
  const denied = (path: string) => AGENT_DENIED_ROUTES.some((r) => endpointUnder(r.prefix, path.replace(/\*$/, "")));

  it("the real route table holds some, so the filter has work to do", () => {
    for (const p of ["/api/sandbox", "/api/mcp/servers", "/api/sync/pull", "/api/secrets"]) {
      expect(scanned.some((r) => r.path === p), p).toBe(true);
    }
  });

  it("keeps none of them, in any spelling the scanner gives a route", () => {
    expect(mapped.filter((r) => denied(r.path))).toEqual([]);
    expect(mapped.every((r) => checkEndpointAccess("agent", r.method, r.path.replace(/\*$/, "")).allowed)).toBe(true);
  });

  it("keeps everything else", () => {
    expect(mapped).toEqual(scanned.filter((r) => !denied(r.path)));
    for (const p of ["/api/settings", "/api/cron"]) expect(mapped.some((r) => r.path === p), p).toBe(true);
  });
});
