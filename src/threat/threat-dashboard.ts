/**
 * Real-Time Threat Dashboard API
 *
 * Exports getThreatDashboard() that returns live threat stats.
 */

import type { ThreatLevel, DataLabel } from "./threat-engine.js";

interface ThreatEvent {
  timestamp: number;
  type: string;
  level: ThreatLevel;
  detail: string;
  toolName?: string;
}

interface ThreatStats {
  totalBlocked: number;
  totalAllowed: number;
  totalWarnings: number;
  blockedByCategory: Record<string, number>;
}

interface ThreatLevelEntry {
  timestamp: number;
  level: ThreatLevel;
  score: number;
}

interface DashboardData {
  timestamp: number;
  currentThreatLevel: ThreatLevel;
  currentScore: number;
  stats: ThreatStats;
  recentEvents: ThreatEvent[];
  threatLevelHistory: ThreatLevelEntry[];
  activeSessions: number;
  topBlockedTools: Array<{ tool: string; count: number }>;
  dataLabelsDetected: Record<string, number>;
}

class ThreatDashboard {
  private events: ThreatEvent[] = [];
  private stats: ThreatStats = {
    totalBlocked: 0,
    totalAllowed: 0,
    totalWarnings: 0,
    blockedByCategory: {},
  };
  private levelHistory: ThreatLevelEntry[] = [];
  private currentLevel: ThreatLevel = "normal";
  private currentScore = 0;
  private sessions = new Set<string>();
  private toolBlockCounts: Record<string, number> = {};
  private labelCounts: Record<string, number> = {};
  private readonly MAX_EVENTS = 500;
  private readonly MAX_HISTORY = 200;

  /** Record a security event */
  recordEvent(event: {
    type: string;
    decision: "allow" | "block" | "warn";
    detail: string;
    toolName?: string;
    threatLevel: ThreatLevel;
    threatScore: number;
    sessionId?: string;
    dataLabels?: DataLabel[];
  }): void {
    const entry: ThreatEvent = {
      timestamp: Date.now(),
      type: event.type,
      level: event.threatLevel,
      detail: event.detail,
      toolName: event.toolName,
    };

    this.events.push(entry);
    if (this.events.length > this.MAX_EVENTS) this.events.shift();

    // Update stats
    if (event.decision === "block") {
      this.stats.totalBlocked++;
      const cat = event.type || "unknown";
      this.stats.blockedByCategory[cat] = (this.stats.blockedByCategory[cat] || 0) + 1;
      if (event.toolName) {
        this.toolBlockCounts[event.toolName] = (this.toolBlockCounts[event.toolName] || 0) + 1;
      }
    } else if (event.decision === "warn") {
      this.stats.totalWarnings++;
    } else {
      this.stats.totalAllowed++;
    }

    // Track threat level history
    if (event.threatLevel !== this.currentLevel || Math.abs(event.threatScore - this.currentScore) > 5) {
      this.levelHistory.push({
        timestamp: Date.now(),
        level: event.threatLevel,
        score: event.threatScore,
      });
      if (this.levelHistory.length > this.MAX_HISTORY) this.levelHistory.shift();
    }

    this.currentLevel = event.threatLevel;
    this.currentScore = event.threatScore;

    // Track sessions
    if (event.sessionId) this.sessions.add(event.sessionId);

    // Track data labels
    if (event.dataLabels) {
      for (const label of event.dataLabels) {
        this.labelCounts[label] = (this.labelCounts[label] || 0) + 1;
      }
    }
  }

  /** Get full dashboard data */
  getDashboard(): DashboardData {
    const topBlocked = Object.entries(this.toolBlockCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    return {
      timestamp: Date.now(),
      currentThreatLevel: this.currentLevel,
      currentScore: this.currentScore,
      stats: { ...this.stats },
      recentEvents: this.events.slice(-50),
      threatLevelHistory: [...this.levelHistory],
      activeSessions: this.sessions.size,
      topBlockedTools: topBlocked,
      dataLabelsDetected: { ...this.labelCounts },
    };
  }

  /** Reset all dashboard state */
  reset(): void {
    this.events = [];
    this.stats = { totalBlocked: 0, totalAllowed: 0, totalWarnings: 0, blockedByCategory: {} };
    this.levelHistory = [];
    this.currentLevel = "normal";
    this.currentScore = 0;
    this.sessions.clear();
    this.toolBlockCounts = {};
    this.labelCounts = {};
  }
}

// Singleton instance
const dashboard = new ThreatDashboard();

/** Record a security event to the dashboard */
export function recordThreatEvent(event: Parameters<ThreatDashboard["recordEvent"]>[0]): void {
  dashboard.recordEvent(event);
}

/** Get the current threat dashboard data */
export function getThreatDashboard(): DashboardData {
  return dashboard.getDashboard();
}

/** Reset dashboard state */
export function resetDashboard(): void {
  dashboard.reset();
}

export type { DashboardData, ThreatEvent, ThreatStats, ThreatLevelEntry };
