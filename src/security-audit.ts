/**
 * Security Self-Audit System
 *
 * Runs on every server start to verify security posture.
 * Two phases:
 *   Shallow — fast config/file checks (no I/O to external services)
 *   Deep    — runtime probes (file permissions, encryption, etc.)
 *
 * Reports findings with severity levels and remediation steps.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type AuditSeverity = "info" | "warn" | "critical";

export interface AuditFinding {
  id: string;
  severity: AuditSeverity;
  title: string;
  detail: string;
  remediation?: string;
}

export interface AuditReport {
  timestamp: number;
  findings: AuditFinding[];
  summary: { info: number; warn: number; critical: number };
  passed: boolean; // true if no critical findings
}

// ── Shallow checks (config + filesystem, no network) ──

function checkSecretsFile(dataDir: string): AuditFinding | null {
  const secretsFile = join(dataDir, "secrets.enc");
  if (!existsSync(secretsFile)) return null; // No secrets yet — fine
  try {
    const stat = statSync(secretsFile);
    // On Windows, mode checks are limited, but we can still verify it exists
    if (stat.size === 0) {
      return {
        id: "secrets-empty",
        severity: "warn",
        title: "Secrets file is empty",
        detail: "secrets.enc exists but has zero bytes",
        remediation: "Re-save your secrets or delete the empty file",
      };
    }
  } catch {
    return {
      id: "secrets-unreadable",
      severity: "warn",
      title: "Cannot read secrets file",
      detail: `Failed to stat ${secretsFile}`,
    };
  }
  return null;
}

function checkAuthTokenStrength(token: string): AuditFinding | null {
  if (!token) {
    return {
      id: "no-auth-token",
      severity: "critical",
      title: "No auth token configured",
      detail: "Server is running without authentication. Anyone on localhost can access all APIs.",
      remediation: "Set SAX_AUTH_TOKEN environment variable or add authToken to ~/.sax/config.json",
    };
  }
  if (token.length < 16) {
    return {
      id: "weak-auth-token",
      severity: "warn",
      title: "Auth token is short",
      detail: `Token is only ${token.length} characters. Recommend 32+ for brute-force resistance.`,
      remediation: "Generate a longer token: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    };
  }
  return null;
}

function checkMasterKey(dataDir: string): AuditFinding | null {
  const dpapiFile = join(dataDir, "master.dpapi");
  const saltFile = join(dataDir, "secrets.salt");

  if (existsSync(dpapiFile)) {
    return {
      id: "dpapi-active",
      severity: "info",
      title: "Encryption: Windows DPAPI active",
      detail: "Master key is protected by Windows user credentials (strongest available)",
    };
  }
  if (existsSync(saltFile)) {
    return {
      id: "fallback-key",
      severity: "warn",
      title: "Encryption: using fallback key derivation",
      detail: "OS keychain not available. Using machine-identity + scrypt (weaker than DPAPI/Keychain).",
      remediation: "Run on a system with Windows DPAPI, macOS Keychain, or Linux libsecret",
    };
  }
  return null;
}

function checkWorkspaceExists(workspace: string): AuditFinding | null {
  if (!existsSync(workspace)) {
    return {
      id: "no-workspace",
      severity: "warn",
      title: "Workspace directory missing",
      detail: `Workspace path ${workspace} does not exist`,
      remediation: "Directory will be auto-created on first use",
    };
  }
  return null;
}

function checkProtectedFiles(): AuditFinding | null {
  const criticalFiles = [
    "src/security.ts",
    "src/auth.ts",
    "src/sanitize.ts",
    "src/keychain.ts",
    "src/threat-engine.ts",
  ];
  const missing = criticalFiles.filter(f => !existsSync(f));
  if (missing.length > 0) {
    return {
      id: "missing-security-files",
      severity: "critical",
      title: "Security files missing",
      detail: `Missing: ${missing.join(", ")}`,
      remediation: "These files are critical for security. Restore from git or reinstall.",
    };
  }
  return null;
}

function checkOAuthTokens(dataDir: string): AuditFinding | null {
  const authFile = join(dataDir, "auth.json");
  if (!existsSync(authFile)) return null;
  try {
    const data = JSON.parse(readFileSync(authFile, "utf-8"));
    if (data.expiresAt && data.expiresAt < Date.now()) {
      return {
        id: "oauth-expired",
        severity: "info",
        title: "OAuth tokens expired",
        detail: "Stored tokens have expired. Will auto-refresh on next API call.",
      };
    }
  } catch {
    return {
      id: "oauth-corrupt",
      severity: "warn",
      title: "OAuth token file corrupt",
      detail: `Cannot parse ${authFile}`,
      remediation: "Delete the file and re-authenticate: rm ~/.sax/auth.json",
    };
  }
  return null;
}

// ── Deep checks (runtime probes) ──

function checkDependencyIntegrity(): AuditFinding | null {
  // Verify package-lock.json exists (prevents dependency confusion)
  if (!existsSync("package-lock.json")) {
    return {
      id: "no-lockfile",
      severity: "warn",
      title: "No package-lock.json",
      detail: "Without a lockfile, npm install may resolve different versions (dependency confusion risk).",
      remediation: "Run npm install to generate package-lock.json and commit it",
    };
  }
  return null;
}

function checkUploadsDir(dataDir: string): AuditFinding | null {
  const uploadsDir = join(dataDir, "uploads");
  if (!existsSync(uploadsDir)) return null;
  try {
    const { readdirSync } = require("node:fs");
    const files = readdirSync(uploadsDir);
    if (files.length > 1000) {
      return {
        id: "uploads-bloat",
        severity: "warn",
        title: "Uploads directory has many files",
        detail: `${files.length} files in uploads. Consider cleanup.`,
        remediation: "Remove old uploads: delete files in ~/.sax/uploads/",
      };
    }
  } catch {}
  return null;
}

// ── Dangerous config flag detection ──

interface DangerousFlag {
  flag: string;
  description: string;
  check: (dataDir: string) => boolean;
}

const DANGEROUS_FLAGS: DangerousFlag[] = [
  {
    flag: "SAX_SANDBOX=disabled",
    description: "Sandbox mode is off — bash commands run directly on host",
    check: () => process.env.SAX_SANDBOX === "disabled" || !process.env.SAX_SANDBOX,
  },
  {
    flag: "SAX_ALLOW_NETWORK_TOOLS=true",
    description: "Direct network tools (curl, wget) allowed in bash",
    check: () => process.env.SAX_ALLOW_NETWORK_TOOLS === "true",
  },
  {
    flag: "NODE_TLS_REJECT_UNAUTHORIZED=0",
    description: "TLS certificate validation disabled — vulnerable to MITM",
    check: () => process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0",
  },
  {
    flag: "SAX_DISABLE_SECURITY",
    description: "Security layer entirely disabled",
    check: () => !!process.env.SAX_DISABLE_SECURITY,
  },
  {
    flag: "No tool policy file",
    description: "No tool-policy.json — all tools allowed by default",
    check: (dataDir: string) => !existsSync(join(dataDir, "tool-policy.json")),
  },
];

function checkDangerousFlags(dataDir: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const flag of DANGEROUS_FLAGS) {
    if (flag.check(dataDir)) {
      findings.push({
        id: `dangerous-flag-${flag.flag.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        severity: flag.flag.includes("DISABLE_SECURITY") || flag.flag.includes("TLS") ? "critical" : "warn",
        title: `Dangerous flag: ${flag.flag}`,
        detail: flag.description,
        remediation: `Unset the environment variable or change the configuration`,
      });
    }
  }
  return findings;
}

// ── Main audit runner ──

export function runSecurityAudit(config: { authToken: string; workspace: string }): AuditReport {
  const dataDir = join(homedir(), ".sax");
  const findings: AuditFinding[] = [];

  // Shallow checks
  const checks = [
    checkAuthTokenStrength(config.authToken),
    checkSecretsFile(dataDir),
    checkMasterKey(dataDir),
    checkWorkspaceExists(config.workspace),
    checkProtectedFiles(),
    checkOAuthTokens(dataDir),
    // Deep checks
    checkDependencyIntegrity(),
    checkUploadsDir(dataDir),
  ];

  // Dangerous config flags (returns multiple findings)
  findings.push(...checkDangerousFlags(dataDir));

  for (const finding of checks) {
    if (finding) findings.push(finding);
  }

  const summary = {
    info: findings.filter(f => f.severity === "info").length,
    warn: findings.filter(f => f.severity === "warn").length,
    critical: findings.filter(f => f.severity === "critical").length,
  };

  return {
    timestamp: Date.now(),
    findings,
    summary,
    passed: summary.critical === 0,
  };
}

/** Pretty-print audit report to console */
export function printAuditReport(report: AuditReport): void {
  const icons = { info: "\x1b[36mℹ\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", critical: "\x1b[31m✖\x1b[0m" };

  console.log(`\n  ── Security Audit ──`);

  if (report.findings.length === 0) {
    console.log(`  ${icons.info} All checks passed\n`);
    return;
  }

  for (const f of report.findings) {
    console.log(`  ${icons[f.severity]} [${f.severity.toUpperCase()}] ${f.title}`);
    if (f.severity !== "info") {
      console.log(`    ${f.detail}`);
      if (f.remediation) console.log(`    Fix: ${f.remediation}`);
    }
  }

  const { info, warn, critical } = report.summary;
  const status = critical > 0 ? "\x1b[31mFAILED\x1b[0m" : warn > 0 ? "\x1b[33mWARNINGS\x1b[0m" : "\x1b[32mPASSED\x1b[0m";
  console.log(`\n  Result: ${status} (${critical} critical, ${warn} warnings, ${info} info)\n`);
}
