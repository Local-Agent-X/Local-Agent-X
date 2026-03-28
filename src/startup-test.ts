import { existsSync, accessSync, constants, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type TestStatus = "pass" | "fail" | "warn";

export interface StartupTestResult {
  name: string;
  status: TestStatus;
  details: string;
  durationMs: number;
  critical: boolean;
}

async function testDiskAccess(): Promise<StartupTestResult> {
  const start = Date.now();
  const testDir = join(homedir(), ".sax");
  const testFile = join(testDir, ".startup-test-probe");

  try {
    accessSync(testDir, constants.R_OK | constants.W_OK);
    writeFileSync(testFile, "probe", "utf-8");
    unlinkSync(testFile);
    return {
      name: "disk_access",
      status: "pass",
      details: `Read/write access to ${testDir} confirmed`,
      durationMs: Date.now() - start,
      critical: true,
    };
  } catch (err) {
    return {
      name: "disk_access",
      status: "fail",
      details: `Cannot read/write ${testDir}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
      critical: true,
    };
  }
}

async function testConfigReadable(): Promise<StartupTestResult> {
  const start = Date.now();
  const configPath = join(homedir(), ".sax", "config.json");

  try {
    if (!existsSync(configPath)) {
      return {
        name: "config_readable",
        status: "warn",
        details: "Config file not found, defaults will be used",
        durationMs: Date.now() - start,
        critical: false,
      };
    }
    accessSync(configPath, constants.R_OK);
    return {
      name: "config_readable",
      status: "pass",
      details: "Config file readable",
      durationMs: Date.now() - start,
      critical: false,
    };
  } catch (err) {
    return {
      name: "config_readable",
      status: "fail",
      details: `Config not readable: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
      critical: false,
    };
  }
}

async function testAuthToken(): Promise<StartupTestResult> {
  const start = Date.now();
  const authPaths = [
    join(homedir(), ".sax", "config.json"),
    join(homedir(), ".sax", "anthropic-auth.json"),
  ];

  for (const p of authPaths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(require("node:fs").readFileSync(p, "utf-8"));
      if (data.authToken || data.access_token || data.apiKey) {
        return {
          name: "auth_token",
          status: "pass",
          details: "Auth token found",
          durationMs: Date.now() - start,
          critical: false,
        };
      }
    } catch {
      // continue checking other files
    }
  }

  return {
    name: "auth_token",
    status: "warn",
    details: "No auth token found; authentication may be required",
    durationMs: Date.now() - start,
    critical: false,
  };
}

async function testProviderReachable(): Promise<StartupTestResult> {
  const start = Date.now();
  const endpoints = [
    { name: "Anthropic", url: "https://api.anthropic.com" },
    { name: "OpenAI", url: "https://api.openai.com" },
  ];

  const results: string[] = [];
  let anyReachable = false;

  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(ep.url, { method: "HEAD", signal: controller.signal });
      clearTimeout(timer);
      results.push(`${ep.name}: reachable`);
      anyReachable = true;
    } catch {
      results.push(`${ep.name}: unreachable`);
    }
  }

  return {
    name: "provider_reachable",
    status: anyReachable ? "pass" : "warn",
    details: results.join("; "),
    durationMs: Date.now() - start,
    critical: false,
  };
}

async function testVoiceEngine(): Promise<StartupTestResult> {
  const start = Date.now();

  // Check for common TTS/voice dependencies
  const voiceIndicators = [
    join(homedir(), ".sax", "voice-tmp"),
    join(homedir(), ".sax", "audio-cues"),
  ];

  const available = voiceIndicators.some((p) => existsSync(p));

  return {
    name: "voice_engine",
    status: available ? "pass" : "warn",
    details: available
      ? "Voice engine directories found"
      : "Voice engine not initialized (will be set up on first use)",
    durationMs: Date.now() - start,
    critical: false,
  };
}

async function testAriKernel(): Promise<StartupTestResult> {
  const start = Date.now();

  // Check if ARI kernel policy files exist
  const policyFile = join(homedir(), ".sax", "custom-policies.json");
  const auditDir = join(homedir(), ".sax", "audit");

  const hasPolicy = existsSync(policyFile);
  const hasAudit = existsSync(auditDir);

  if (hasPolicy || hasAudit) {
    return {
      name: "ari_kernel",
      status: "pass",
      details: "ARI kernel data found",
      durationMs: Date.now() - start,
      critical: false,
    };
  }

  return {
    name: "ari_kernel",
    status: "warn",
    details: "ARI kernel not yet configured (will initialize on first use)",
    durationMs: Date.now() - start,
    critical: false,
  };
}

export async function runStartupTests(): Promise<StartupTestResult[]> {
  const tests = [
    testDiskAccess(),
    testConfigReadable(),
    testAuthToken(),
    testProviderReachable(),
    testVoiceEngine(),
    testAriKernel(),
  ];

  const results = await Promise.all(tests);

  // Check for critical failures
  const criticalFailures = results.filter((r) => r.critical && r.status === "fail");
  if (criticalFailures.length > 0) {
    const names = criticalFailures.map((r) => r.name).join(", ");
    throw new Error(`Critical startup tests failed: ${names}`);
  }

  return results;
}
