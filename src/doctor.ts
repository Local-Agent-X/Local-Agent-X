/**
 * Doctor — self-diagnostics system.
 * Checks API keys, connectivity, dependencies, config, workspace, and tools.
 * Returns actionable results so users can fix issues without guessing.
 */

import { existsSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { getLaxDir } from "./lax-data-dir.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export interface DiagnosticResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface DoctorReport {
  timestamp: number;
  results: DiagnosticResult[];
  passed: number;
  warned: number;
  failed: number;
  healthy: boolean;
}

type CheckFn = () => Promise<DiagnosticResult> | DiagnosticResult;

// ── Individual Checks ──

function checkConfigExists(): DiagnosticResult {
  const cfgPath = join(getLaxDir(), "config.json");
  if (!existsSync(cfgPath)) {
    return { name: "Config file", status: "fail", message: "~/.lax/config.json not found", fix: "Run the server once to auto-generate config" };
  }
  try {
    const cfg = JSON.parse(require("fs").readFileSync(cfgPath, "utf-8"));
    if (!cfg.authToken) return { name: "Config file", status: "warn", message: "Auth token is empty", fix: "Restart the server to generate an auth token" };
    return { name: "Config file", status: "pass", message: "Config valid" };
  } catch (e) {
    return { name: "Config file", status: "fail", message: `Config parse error: ${(e as Error).message}`, fix: "Fix JSON syntax in ~/.lax/config.json" };
  }
}

function checkWorkspace(): DiagnosticResult {
  const wsDir = resolve("workspace");
  if (!existsSync(wsDir)) {
    return { name: "Workspace directory", status: "warn", message: "workspace/ not found", fix: "It will be auto-created on first use" };
  }
  try {
    accessSync(wsDir, constants.W_OK);
    return { name: "Workspace directory", status: "pass", message: "Writable" };
  } catch {
    return { name: "Workspace directory", status: "fail", message: "workspace/ is not writable", fix: "Check directory permissions" };
  }
}

function checkDatabase(): DiagnosticResult {
  const dbPath = join(getLaxDir(), "db.sqlite");
  if (!existsSync(dbPath)) {
    return { name: "Database", status: "warn", message: "db.sqlite not found — will be created on first use" };
  }
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    db.prepare("SELECT 1").get();
    db.close();
    return { name: "Database", status: "pass", message: "SQLite healthy" };
  } catch (e) {
    return { name: "Database", status: "fail", message: `SQLite error: ${(e as Error).message}`, fix: "Database may be corrupted — rename db.sqlite and restart" };
  }
}

async function checkApiKey(name: string, keyEnv: string, testUrl: string, headers: Record<string, string>): Promise<DiagnosticResult> {
  const key = process.env[keyEnv];
  if (!key) {
    // Check secrets vault
    try {
      const vaultPath = join(getLaxDir(), "secrets-vault.json");
      if (existsSync(vaultPath)) {
        const vault = JSON.parse(require("fs").readFileSync(vaultPath, "utf-8"));
        if (vault[keyEnv] || vault[name.toUpperCase().replace(/\s+/g, "_") + "_API_KEY"]) {
          return { name: `${name} API key`, status: "pass", message: "Found in secrets vault" };
        }
      }
    } catch {}
    return { name: `${name} API key`, status: "warn", message: "Not configured", fix: `Set ${keyEnv} in Settings → API Keys or secrets vault` };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(testUrl, { method: "GET", headers: { ...headers, Authorization: `Bearer ${key}` }, signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok || res.status === 404) return { name: `${name} API key`, status: "pass", message: "Valid and reachable" };
    if (res.status === 401 || res.status === 403) return { name: `${name} API key`, status: "fail", message: "Invalid or expired key", fix: `Update ${keyEnv} in Settings` };
    return { name: `${name} API key`, status: "warn", message: `API returned ${res.status}` };
  } catch (e) {
    return { name: `${name} API key`, status: "warn", message: `Cannot reach API: ${(e as Error).message}` };
  }
}

function checkGit(): DiagnosticResult {
  try {
    const version = execSync("git --version", { timeout: 5000 }).toString().trim();
    return { name: "Git", status: "pass", message: version };
  } catch {
    return { name: "Git", status: "warn", message: "Git not found", fix: "Install Git for agent worktree support" };
  }
}

function checkNode(): DiagnosticResult {
  const version = process.version;
  const major = parseInt(version.slice(1), 10);
  if (major < 20) return { name: "Node.js", status: "warn", message: `${version} (recommend 20+)`, fix: "Upgrade Node.js to v20 or later" };
  return { name: "Node.js", status: "pass", message: version };
}

function checkPlaywright(): DiagnosticResult {
  try {
    require.resolve("playwright");
    return { name: "Playwright", status: "pass", message: "Installed" };
  } catch {
    return { name: "Playwright", status: "warn", message: "Not installed — browser tools disabled", fix: "npm install playwright && npx playwright install chromium" };
  }
}

function checkDiskSpace(): DiagnosticResult {
  try {
    const laxDir = getLaxDir();
    // Rough check: try to write a temp file
    const tmpFile = join(laxDir, ".doctor-check");
    require("fs").writeFileSync(tmpFile, "ok");
    require("fs").unlinkSync(tmpFile);
    return { name: "Disk space", status: "pass", message: "Writable" };
  } catch {
    return { name: "Disk space", status: "fail", message: "Cannot write to ~/.lax/", fix: "Free up disk space or check permissions" };
  }
}

function checkMemoryDir(): DiagnosticResult {
  const memDir = join(getLaxDir(), "memory");
  if (!existsSync(memDir)) return { name: "Memory system", status: "warn", message: "No memory directory yet — will be created on first use" };
  try {
    const files = require("fs").readdirSync(memDir) as string[];
    return { name: "Memory system", status: "pass", message: `${files.length} memory files` };
  } catch (e) {
    return { name: "Memory system", status: "warn", message: `Cannot read memory: ${(e as Error).message}` };
  }
}

function checkSecretsVault(): DiagnosticResult {
  const vaultPath = join(getLaxDir(), "secrets-vault.json");
  if (!existsSync(vaultPath)) return { name: "Secrets vault", status: "pass", message: "No secrets stored" };
  try {
    const vault = JSON.parse(require("fs").readFileSync(vaultPath, "utf-8"));
    const count = Object.keys(vault).length;
    return { name: "Secrets vault", status: "pass", message: `${count} secret(s) stored` };
  } catch {
    return { name: "Secrets vault", status: "warn", message: "Vault file corrupted", fix: "Delete and re-add secrets" };
  }
}

// ── Run All Checks ──

export async function runDoctor(): Promise<DoctorReport> {
  const checks: CheckFn[] = [
    checkNode,
    checkConfigExists,
    checkWorkspace,
    checkDatabase,
    checkDiskSpace,
    checkGit,
    checkPlaywright,
    checkMemoryDir,
    checkSecretsVault,
    () => checkApiKey("OpenAI", "OPENAI_API_KEY", "https://api.openai.com/v1/models", {}),
    () => checkApiKey("Anthropic", "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/models", { "anthropic-version": "2023-06-01" }),
    () => checkApiKey("xAI", "XAI_API_KEY", "https://api.x.ai/v1/models", {}),
  ];

  const results: DiagnosticResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check());
    } catch (e) {
      results.push({ name: "Unknown check", status: "fail", message: (e as Error).message });
    }
  }

  const passed = results.filter(r => r.status === "pass").length;
  const warned = results.filter(r => r.status === "warn").length;
  const failed = results.filter(r => r.status === "fail").length;

  return { timestamp: Date.now(), results, passed, warned, failed, healthy: failed === 0 };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["## System Diagnostics", ""];
  const icons = { pass: "PASS", warn: "WARN", fail: "FAIL" };

  for (const r of report.results) {
    lines.push(`[${icons[r.status]}] ${r.name}: ${r.message}`);
    if (r.fix) lines.push(`       Fix: ${r.fix}`);
  }

  lines.push("");
  lines.push(`Results: ${report.passed} passed, ${report.warned} warnings, ${report.failed} failures`);
  lines.push(report.healthy ? "Status: Healthy" : "Status: Issues detected — see fixes above");
  return lines.join("\n");
}
