import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __mcpLocalTrustPathForTests, isMcpTrustedLocally, setMcpLocalTrust } from "./local-trust.js";

describe("MCP local trust ledger", () => {
  it("blocks synced trusted config until the exact config is locally approved", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-mcp-local-trust-"));
    const config = { command: "npx", args: ["-y", "example-mcp"], executionMode: "trusted" as const };
    try {
      expect(isMcpTrustedLocally(dataDir, "example", config)).toBe(false);
      setMcpLocalTrust(dataDir, "example", config, true);
      expect(isMcpTrustedLocally(dataDir, "example", config)).toBe(true);
      expect(isMcpTrustedLocally(dataDir, "example", { ...config, args: ["-y", "different-mcp"] })).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stores only a fingerprint in a local file outside mcp.json", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-mcp-local-trust-"));
    const config = { command: "node", args: ["server.js"], env: { TOKEN: "${secret:LOCAL}" }, executionMode: "trusted" as const };
    try {
      setMcpLocalTrust(dataDir, "local", config, true);
      const path = __mcpLocalTrustPathForTests(dataDir);
      const raw = readFileSync(path, "utf8");
      expect(path).toBe(join(dataDir, "mcp-local-trust.json"));
      expect(raw).not.toContain("server.js");
      expect(raw).not.toContain("${secret:LOCAL}");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
