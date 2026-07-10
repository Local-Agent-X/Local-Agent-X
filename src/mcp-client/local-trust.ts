import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../server-utils.js";
import type { MCPServerConfig } from "./types.js";

const LEDGER_FILE = "mcp-local-trust.json";

interface TrustLedger {
  approved: Record<string, { fingerprint: string; approvedAt: string }>;
}

function ledgerPath(dataDir: string): string {
  return join(dataDir, LEDGER_FILE);
}

function loadLedger(dataDir: string): TrustLedger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(dataDir), "utf8")) as Partial<TrustLedger>;
    if (parsed.approved && typeof parsed.approved === "object") return { approved: parsed.approved };
  } catch { /* missing or malformed ledgers fail closed */ }
  return { approved: {} };
}

export function mcpTrustFingerprint(name: string, config: MCPServerConfig): string {
  const stable = JSON.stringify({
    name,
    command: config.command,
    args: config.args ?? [],
    env: Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    executionMode: config.executionMode ?? "sandboxed",
    manifest: config.manifest ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export function isMcpTrustedLocally(dataDir: string, name: string, config: MCPServerConfig): boolean {
  const entry = loadLedger(dataDir).approved[name];
  return entry?.fingerprint === mcpTrustFingerprint(name, config);
}

export function setMcpLocalTrust(dataDir: string, name: string, config: MCPServerConfig, approved: boolean): void {
  const ledger = loadLedger(dataDir);
  if (approved) {
    ledger.approved[name] = { fingerprint: mcpTrustFingerprint(name, config), approvedAt: new Date().toISOString() };
  } else {
    delete ledger.approved[name];
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(ledgerPath(dataDir), JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
}

export function __mcpLocalTrustPathForTests(dataDir: string): string {
  return ledgerPath(dataDir);
}
