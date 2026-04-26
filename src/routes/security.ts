import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody, safeParseBody, safeErrorMessage } from "../server-utils.js";
import { getThreatDashboard } from "../threat-dashboard.js";
import { listPolicies, createPolicy, deletePolicy } from "../ari-policy-editor.js";
import { listEgressRules, addEgressRule } from "../egress-policy.js";
import { scanForSecrets } from "../secret-scanner.js";
import { getRecentFileAccess } from "../file-audit.js";
import { queryAuditLog, getAuditSummary } from "../ari-audit-viewer.js";
import { runBenchmarks } from "../ari-benchmarks.js";
import { runInjectionTests } from "../security-tests.js";
import { setSessionPolicy, getSessionPolicy, listPresets, type PolicyPreset } from "../session-policy.js";
import { isAriActive } from "../ari-kernel.js";
import { ThreatEngine } from "../threat-engine.js";

import { createLogger } from "../logger.js";
const logger = createLogger("routes.security");

export const handleSecurityRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/security/dashboard") {
    json(200, getThreatDashboard()); return true;
  }
  if (method === "GET" && url.pathname === "/api/security/policies") {
    json(200, listPolicies()); return true;
  }
  if (method === "POST" && url.pathname === "/api/security/policies") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    json(200, createPolicy(body as Omit<import("../ari-policy-editor.js").PolicyRule, "id" | "createdAt" | "updatedAt">)); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/security/policies/")) {
    const id = url.pathname.split("/").pop()!;
    json(200, { ok: deletePolicy(id) }); return true;
  }
  if (method === "GET" && url.pathname === "/api/security/egress") {
    json(200, { rules: listEgressRules() }); return true;
  }
  if (method === "POST" && url.pathname === "/api/security/egress") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    json(200, addEgressRule(body.domain as string, body.action as "allow" | "block", body.reason as string | undefined)); return true;
  }
  if (method === "GET" && url.pathname === "/api/security/audit") {
    const query = Object.fromEntries(url.searchParams.entries());
    json(200, await queryAuditLog(query)); return true;
  }
  if (method === "GET" && url.pathname === "/api/security/audit/summary") {
    json(200, await getAuditSummary()); return true;
  }
  if (method === "GET" && url.pathname === "/api/security/file-access") {
    json(200, getRecentFileAccess(50)); return true;
  }
  if (method === "POST" && url.pathname === "/api/security/scan") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    json(200, scanForSecrets(String(body.text || ""))); return true;
  }
  if (method === "POST" && url.pathname === "/api/security/benchmarks") {
    json(200, await runBenchmarks()); return true;
  }
  if (method === "POST" && url.pathname === "/api/security/injection-tests") {
    json(200, runInjectionTests()); return true;
  }

  // File access mode
  if (method === "GET" && url.pathname === "/api/security/file-access") {
    json(200, { mode: ctx.security.fileAccessMode }); return true;
  }
  if (method === "POST" && url.pathname === "/api/security/file-access") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const mode = String(body.mode || "");
    if (!["workspace", "common", "unrestricted"].includes(mode)) {
      json(400, { error: "mode must be: workspace, common, or unrestricted" }); return true;
    }
    ctx.security.setFileAccessMode(mode as "workspace" | "common" | "unrestricted");
    json(200, { ok: true, mode }); return true;
  }

  // Tool policy toggles
  if (method === "GET" && url.pathname === "/api/tool-policy/status") {
    const policyPath = join(ctx.dataDir, "tool-policy.json");
    try {
      const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, "utf-8")) as { defaultDecision: string; rules: Array<{ id: string; decision: string }> } : { defaultDecision: "deny", rules: [] as Array<{ id: string; decision: string }> };
      const bashRule = policy.rules.find((r) => r.id === "allow-bash-limited");
      const httpRule = policy.rules.find((r) => r.id === "allow-http-limited");
      const browserRule = policy.rules.find((r) => r.id === "allow-browser");
      json(200, {
        bash: bashRule ? bashRule.decision !== "deny" : true,
        http: httpRule ? httpRule.decision !== "deny" : true,
        browser: browserRule ? browserRule.decision !== "deny" : true,
      });
    } catch { json(200, { bash: true, http: true, browser: true }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/tool-policy/toggle") {
    const body = await readBody(req);
    const { tool, enabled } = JSON.parse(body);
    const ruleMap: Record<string, string> = { bash: "allow-bash-limited", http: "allow-http-limited", browser: "allow-browser" };
    const ruleId = ruleMap[tool];
    if (!ruleId) { json(400, { error: "Unknown tool. Use: bash, http, browser" }); return true; }
    const policyPath = join(ctx.dataDir, "tool-policy.json");
    try {
      let policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, "utf-8")) as { defaultDecision: string; rules: Array<{ id: string; tool?: string; decision: string; reason?: string; priority?: number }> } : { defaultDecision: "deny" as string, rules: [] as Array<{ id: string; tool?: string; decision: string; reason?: string; priority?: number }> };
      const rule = policy.rules.find((r) => r.id === ruleId);
      if (rule) {
        rule.decision = enabled ? "allow" : "deny";
      } else {
        policy.rules.push({ id: ruleId, tool: tool === "http" ? "http_request" : tool, decision: enabled ? "allow" : "deny", reason: enabled ? "Enabled via settings" : "Disabled via settings", priority: 40 });
      }
      writeFileSync(policyPath, JSON.stringify(policy, null, 2), { encoding: "utf-8", mode: 0o600 });
      json(200, { ok: true, tool, enabled });
    } catch (e) {
      json(500, { error: "Failed to update policy: " + (e instanceof Error ? e.message : String(e)) });
    }
    return true;
  }

  // ARI status
  if (method === "GET" && url.pathname === "/api/ari-status") {
    const { ariStatus } = await import("../ari-kernel.js");
    json(200, { active: isAriActive(), status: await ariStatus() }); return true;
  }

  // Session policy
  if (method === "GET" && url.pathname === "/api/session-policy") {
    const sessionId = url.searchParams.get("sessionId") || "default";
    json(200, { policy: getSessionPolicy(sessionId), presets: listPresets() }); return true;
  }
  if (method === "POST" && url.pathname === "/api/session-policy") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const sessionId = (body.sessionId as string) || "default";
    const preset = body.preset as PolicyPreset;
    if (!listPresets().includes(preset)) {
      json(400, { error: `Invalid preset. Available: ${listPresets().join(", ")}` }); return true;
    }
    const policy = setSessionPolicy(sessionId, preset);
    logger.info(`[security] Session ${sessionId} policy set to: ${preset}`);
    json(200, { ok: true, policy }); return true;
  }

  // Audit
  if (method === "GET" && url.pathname === "/api/audit") {
    const count = parseInt(url.searchParams.get("count") || "50", 10);
    const auditReader = new ThreatEngine(ctx.dataDir, "audit-read");
    json(200, auditReader.audit.getRecent(Math.min(count, 500))); return true;
  }
  if (method === "GET" && url.pathname === "/api/audit/verify") {
    const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(400, { error: "Invalid date format" }); return true; }
    const [y, m, d] = date.split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) { json(400, { error: "Invalid date values" }); return true; }
    const auditPath = join(ctx.dataDir, "audit", `${date}.jsonl`);
    const { CryptoAuditTrail } = await import("../threat-engine.js");
    json(200, CryptoAuditTrail.verify(auditPath)); return true;
  }

  return false;
};
