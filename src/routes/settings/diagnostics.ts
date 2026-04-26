import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";
import { getToolStats, getToolSuccessRate, getRecentFailures } from "../../tool-tracker.js";
import { getCrashReport, getTopCrashPatterns } from "../../crash-analytics.js";
import { getContextUsage } from "../../context-usage.js";
import { runStartupTests } from "../../startup-test.js";

export const handleDiagnosticsRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Tool stats
  if (method === "GET" && url.pathname === "/api/tools/stats") {
    json(200, { stats: getToolStats(), successRate: getToolSuccessRate(), recentFailures: getRecentFailures(20) }); return true;
  }

  // Top failing tools — ranked by failure rate over recent calls
  if (method === "GET" && url.pathname === "/api/tools/top-failures") {
    const stats = getToolStats();
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);
    const ranked = Object.entries(stats)
      .filter(([, s]) => (s.totalCalls || 0) >= 3) // ignore noise
      .map(([name, s]) => ({
        name,
        totalCalls: s.totalCalls || 0,
        failures: s.failures || 0,
        failureRate: s.totalCalls ? (s.failures || 0) / s.totalCalls : 0,
        avgDurationMs: Math.round(s.avgDurationMs || 0),
        lastFailure: s.lastFailure,
        lastFailureTime: s.lastFailureTime,
      }))
      .filter((t) => t.failures > 0)
      .sort((a, b) => b.failureRate - a.failureRate || b.failures - a.failures)
      .slice(0, limit);
    json(200, { tools: ranked, recent: getRecentFailures(20) }); return true;
  }

  // Circuit breaker snapshot — which (session, tool) breakers are tripped
  if (method === "GET" && url.pathname === "/api/circuit-breakers") {
    const { getCircuitSnapshot } = await import("../../circuit-breaker.js");
    json(200, { breakers: getCircuitSnapshot() }); return true;
  }

  // Correction history — patterns the user has flagged
  if (method === "GET" && url.pathname === "/api/corrections") {
    try {
      const { CorrectionLearner } = await import("../../correction-learning.js");
      const learner = CorrectionLearner.getInstance();
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const history = learner.getCorrectionHistory().slice(-limit);
      json(200, {
        recent: history,
        patterns: learner.getFrequentMistakes(),
      });
    } catch (e) {
      json(500, { error: (e as Error).message });
    }
    return true;
  }

  // Response quality scores (per session)
  if (method === "GET" && url.pathname === "/api/quality") {
    const { getAverageQuality } = await import("../../quality-scorer.js");
    const sessionId = url.searchParams.get("sessionId") || undefined;
    json(200, { average: getAverageQuality(sessionId) }); return true;
  }

  // Worker sessions (IDE worker pattern)
  if (method === "GET" && url.pathname === "/api/workers") {
    const { listWorkerSessions } = await import("../../worker-session.js");
    json(200, { workers: listWorkerSessions() }); return true;
  }

  // Crashes
  if (method === "GET" && url.pathname === "/api/crashes") {
    json(200, { report: getCrashReport(), topPatterns: getTopCrashPatterns(10) }); return true;
  }

  // Context usage
  if (method === "GET" && url.pathname === "/api/context/usage") {
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId) {
      const session = ctx.getOrCreateSession(sessionId);
      if (session) { json(200, getContextUsage(session.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>, 128000)); return true; }
    }
    json(200, { used: 0, max: 128000, percentage: 0, remaining: 128000 }); return true;
  }

  // Startup tests
  if (method === "GET" && url.pathname === "/api/startup-tests") {
    json(200, { results: await runStartupTests() }); return true;
  }

  // Usage/cost report API
  if (method === "GET" && url.pathname === "/api/usage") {
    try {
      const { getUsageSummary, getTodayCost } = await import("../../cost-tracker.js");
      const period = url.searchParams.get("period") || "today";
      if (period === "today") {
        json(200, getTodayCost());
      } else {
        const since = period === "week" ? Date.now() - 7 * 86400000 : period === "month" ? Date.now() - 30 * 86400000 : undefined;
        json(200, getUsageSummary({ since }));
      }
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  // Doctor / self-diagnostics API
  if (method === "GET" && url.pathname === "/api/doctor") {
    try {
      const { runDoctor } = await import("../../doctor.js");
      const report = await runDoctor();
      json(200, report);
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  return false;
};
