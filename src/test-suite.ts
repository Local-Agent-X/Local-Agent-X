import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

const BASE = "http://127.0.0.1:7007";

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

function loadToken(): string {
  const cfgPath = join(homedir(), ".sax", "config.json");
  const raw = readFileSync(cfgPath, "utf-8");
  const cfg = JSON.parse(raw);
  return cfg.token ?? cfg.authToken ?? "";
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function record(
  category: string,
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const t0 = performance.now();
  try {
    await fn();
    results.push({ name, category, passed: true, duration: performance.now() - t0 });
  } catch (err: any) {
    results.push({
      name,
      category,
      passed: false,
      duration: performance.now() - t0,
      error: err?.message ?? String(err),
    });
  }
}

// ── API endpoint tests ──

async function testEndpoints(token: string): Promise<void> {
  const gets: [string, string][] = [
    ["/api/health", "GET /api/health"],
    ["/api/tools/stats", "GET /api/tools/stats"],
    ["/api/crashes", "GET /api/crashes"],
    ["/api/docs", "GET /api/docs"],
    ["/api/plugins", "GET /api/plugins"],
    ["/api/security/dashboard", "GET /api/security/dashboard"],
    ["/api/security/policies", "GET /api/security/policies"],
    ["/api/security/audit/summary", "GET /api/security/audit/summary"],
    ["/api/security/file-access", "GET /api/security/file-access"],
    ["/api/voice/capabilities", "GET /api/voice/capabilities"],
    ["/api/sessions", "GET /api/sessions"],
    ["/api/startup-tests", "GET /api/startup-tests"],
  ];

  for (const [path, label] of gets) {
    await record("API Endpoints", label, async () => {
      const res = await fetch(`${BASE}${path}`, { headers: headers(token) });
      if (res.status !== 200) {
        throw new Error(`expected 200, got ${res.status}`);
      }
    });
  }

  const posts: [string, string, unknown][] = [
    ["/api/security/scan", "POST /api/security/scan", { text: "test string" }],
    ["/api/security/injection-tests", "POST /api/security/injection-tests", {}],
    ["/api/security/benchmarks", "POST /api/security/benchmarks", {}],
  ];

  for (const [path, label, body] of posts) {
    await record("API Endpoints", label, async () => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify(body),
      });
      if (res.status !== 200) {
        throw new Error(`expected 200, got ${res.status}`);
      }
    });
  }
}

// ── Module import tests ──

async function testModuleImports(): Promise<void> {
  const modules = [
    "./tool-tracker.js",
    "./auto-retry.js",
    "./session-recovery.js",
    "./error-categories.js",
    "./provider-fallback.js",
    "./quality-scorer.js",
    "./context-usage.js",
    "./conversation-compactor.js",
    "./parallel-tools.js",
    "./tool-timeout.js",
    "./stream-reliability.js",
    "./memory-dedup.js",
    "./session-export.js",
    "./crash-analytics.js",
    "./response-cache.js",
    "./offline-queue.js",
    "./progressive-loader.js",
    "./db-migrations.js",
    "./startup-test.js",
    "./plugin-system.js",
    "./tool-sdk.js",
    "./headless.js",
    "./api-docs.js",
    "./event-bus.js",
    "./config-hot-reload.js",
    "./io-abstraction.js",
    "./portable-memory.js",
    "./embedded-runtime.js",
    "./driver-abstraction.js",
    "./agent-protocol.js",
    "./ipc-channel.js",
    "./compute-offload.js",
    "./battery-scheduler.js",
    "./ota-update.js",
    "./demo-recorder.js",
    "./demo-runner.js",
    "./benchmark-suite.js",
    "./swarm/index.js",
    "./swarm/primal.js",
    "./security-tests.js",
    "./threat-dashboard.js",
    "./ari-policy-editor.js",
    "./egress-policy.js",
    "./secret-scanner.js",
    "./file-audit.js",
    "./tool-rate-limiter.js",
    "./ari-benchmarks.js",
    "./ari-audit-viewer.js",
    "./voice-commands.js",
    "./voice-fast.js",
    "./voice-auth.js",
    "./voice-timeline.js",
    "./tts-stream.js",
    "./camera-tool.js",
    "./screen-capture.js",
    "./ocr-tool.js",
    "./speaker-id.js",
    "./audio-agent.js",
    "./audio-cues.js",
    "./video-summary.js",
    "./missions/index.js",
  ];

  for (const mod of modules) {
    await record("Module Imports", `import ${mod}`, async () => {
      await import(mod);
    });
  }
}

// ── Tool registration tests ──

async function testToolRegistration(): Promise<void> {
  const expected = [
    "agent_spawn",
    "agent_status",
    "delegate",
    "swarm_create",
    "mission_list",
    "bash",
    "read",
    "write",
    "edit",
    "browser",
  ];

  // Check tools by importing each module that creates them
  const toolSources: Record<string, () => Promise<string[]>> = {
    "base tools": async () => { const m = await import("./tools.js"); const t = typeof (m.allTools as any) === "function" ? (m.allTools as any)() : m.allTools; return Array.isArray(t) ? t.map((x: any) => x.name || "") : []; },
    "swarm tools": async () => { const m = await import("./swarm/index.js"); return m.createSwarmTools().map((t: any) => t.name); },
    "primal tools": async () => { const m = await import("./swarm/primal.js"); return m.createPrimalTools().map((t: any) => t.name); },
    "mission tools": async () => { const m = await import("./missions.js"); return m.createMissionTools().map((t: any) => t.name); },
    "browser tools": async () => { const m = await import("./browser-tools.js"); return m.createBrowserTools(() => "default").map((t: any) => t.name); },
  };
  const allToolNames: string[] = [];
  for (const [src, loader] of Object.entries(toolSources)) {
    try { allToolNames.push(...await loader()); } catch { /* skip */ }
  }

  for (const name of expected) {
    await record("Tool Registration", `tool: ${name}`, async () => {
      if (!allToolNames.includes(name)) {
        throw new Error(`tool "${name}" not found in registered tools`);
      }
    });
  }
}

// ── Security tests ──

async function testSecurity(token: string): Promise<void> {
  await record("Security", "detect secret in text", async () => {
    const res = await fetch(`${BASE}/api/security/scan`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ text: "my key is sk-abcdefghij1234567890abcdefghij1234 do not share" }),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data: any = await res.json();
    const found =
      data.clean === false ||
      data.matches?.length > 0 ||
      data.secrets?.length > 0 ||
      data.detected === true;
    if (!found) throw new Error("scanner did not flag the embedded secret");
  });

  await record("Security", "clean text passes scan", async () => {
    const res = await fetch(`${BASE}/api/security/scan`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ text: "hello world" }),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const data: any = await res.json();
    const clean =
      (data.secrets?.length ?? 0) === 0 &&
      (data.findings?.length ?? 0) === 0 &&
      data.detected !== true &&
      (data.count ?? 0) === 0 &&
      data.found !== true;
    if (!clean) throw new Error("scanner flagged clean text as containing secrets");
  });
}

// ── WebSocket test ──

async function testWebSocket(token: string): Promise<void> {
  await record("WebSocket", "ws connect", async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("websocket connection timed out after 5s"));
      }, 5000);

      const ws = new WebSocket(
        `ws://127.0.0.1:7007/ws/chat?token=${encodeURIComponent(token)}`,
      );

      ws.on("open", () => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });
}

// ── Report printer ──

function printReport(elapsed: number): void {
  const cats = new Map<string, { total: number; passed: number }>();
  for (const r of results) {
    let c = cats.get(r.category);
    if (!c) {
      c = { total: 0, passed: 0 };
      cats.set(r.category, c);
    }
    c.total++;
    if (r.passed) c.passed++;
  }

  const totalTests = results.length;
  const totalPassed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);

  const bar = "\u2550".repeat(38);
  const thin = "\u2500".repeat(38);

  console.log();
  console.log(bar);
  console.log("  OPEN AGENT X \u2014 TEST REPORT");
  console.log(bar);
  console.log();

  const order = [
    "API Endpoints",
    "Module Imports",
    "Tool Registration",
    "Security",
    "WebSocket",
  ];

  for (const cat of order) {
    const c = cats.get(cat);
    if (!c) continue;
    const label = cat.padEnd(22);
    const count = `${c.passed}/${c.total} passed`;
    console.log(`${label} ${count}`);
  }

  console.log(thin);
  const allOk = totalPassed === totalTests;
  const tag = allOk ? " \u2713" : " \u2717";
  console.log(`TOTAL${" ".repeat(17)} ${totalPassed}/${totalTests} passed${tag}`);
  console.log();

  if (failed.length > 0) {
    console.log("Failed tests:");
    for (const f of failed) {
      console.log(`  [${f.category}] ${f.name}`);
      if (f.error) console.log(`    ${f.error}`);
    }
  } else {
    console.log("Failed tests:");
    console.log("  (none)");
  }

  console.log();
  console.log(`Time: ${(elapsed / 1000).toFixed(1)}s`);
  console.log();
}

// ── Main ──

async function main(): Promise<void> {
  const token = loadToken();
  if (!token) {
    console.error("Could not read auth token from ~/.sax/config.json");
    process.exit(1);
  }

  const t0 = performance.now();

  await testEndpoints(token);
  await testModuleImports();
  await testToolRegistration();
  await testSecurity(token);
  await testWebSocket(token);

  const elapsed = performance.now() - t0;
  printReport(elapsed);

  const anyFailed = results.some((r) => !r.passed);
  process.exit(anyFailed ? 1 : 0);
}

main();
