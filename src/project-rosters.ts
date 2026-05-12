/**
 * Project Rosters — per-project hire records.
 *
 * Today (pre-L3) the AgentTemplate carries hire/reportsTo/heartbeat/
 * budget directly on the definition. That couples "what the agent IS"
 * with "where it sits in an org" — wrong, because the same agent
 * (same template id) can be hired into multiple projects with
 * independent metadata in each. A Researcher reporting to CEO Alpha
 * in Project Alpha is the same Researcher *definition* as the
 * Researcher reporting to CEO Beta in Project Beta.
 *
 * This module is where the (projectId, agentId) tuple becomes a real
 * record. AgentDefinition (and its legacy form AgentTemplate) stay
 * pure definitions. ProjectRoster is the "membership" axis.
 *
 * Storage: ~/.lax/project-rosters.json, keyed by `${projectId}:${agentId}`.
 *
 * Migration: on first init this module reads the legacy
 * agent-templates.json + agent-projects.json, derives roster entries
 * for every (project, hired-agent-template) pair that exists today,
 * writes project-rosters.json. Templates that were `hired: true` but
 * not on any project's roster are dropped — per the canonical Q4
 * lock, hire is always a Project action; orphaned global hires don't
 * have a coherent destination.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { createLogger } from "./logger.js";
const logger = createLogger("project-rosters");

const ROSTERS_FILE = join(homedir(), ".lax", "project-rosters.json");
const LEGACY_TEMPLATES_FILE = join(homedir(), ".lax", "agent-templates.json");
const LEGACY_PROJECTS_FILE = join(homedir(), ".lax", "agent-projects.json");

/** One agent's membership record in one project. */
export interface ProjectRoster {
  projectId: string;
  agentId: string;
  /** Org-chart hierarchy — agent this one reports to *within this project*.
   *  Same agent in two projects can have different managers. */
  reportsTo?: string;
  /** Cron-style wake-up schedule, project-scoped. */
  heartbeatSchedule?: string;
  heartbeatEnabled?: boolean;
  /** Monthly spend cap + ledger, project-scoped. */
  budget?: { maxPerMonth: number; spent: number; resetAt: number };
  createdAt: number;
  updatedAt: number;
}

/** Shape persisted to disk — keyed map for cheap lookup. */
type RosterIndex = Record<string, ProjectRoster>;

function rosterKey(projectId: string, agentId: string): string {
  return `${projectId}:${agentId}`;
}

interface LegacyAgentTemplate {
  id: string;
  hired?: boolean;
  reportsTo?: string;
  heartbeatSchedule?: string;
  heartbeatEnabled?: boolean;
  budget?: { maxPerMonth: number; spent: number; resetAt: number };
  [k: string]: unknown;
}

interface LegacyProject {
  id: string;
  agentIds?: string[];
  [k: string]: unknown;
}

export class ProjectRosterStore {
  private static instance: ProjectRosterStore | null = null;
  private rosters: RosterIndex = {};

  private constructor() {
    if (existsSync(ROSTERS_FILE)) {
      try {
        this.rosters = JSON.parse(readFileSync(ROSTERS_FILE, "utf-8"));
      } catch (e) {
        logger.warn(`failed to parse ${ROSTERS_FILE}: ${(e as Error).message}; starting empty`);
        this.rosters = {};
      }
    } else {
      this.rosters = this.migrateFromLegacy();
      this.persist();
    }
  }

  static getInstance(): ProjectRosterStore {
    if (!ProjectRosterStore.instance) ProjectRosterStore.instance = new ProjectRosterStore();
    return ProjectRosterStore.instance;
  }

  /** Test-only: reset state so fixtures don't bleed between cases. */
  static _resetForTest(): void {
    ProjectRosterStore.instance = null;
  }

  /**
   * Read the legacy stores and build initial roster entries.
   * For every (project, agent) pair where the project lists the agent
   * in agentIds, create a roster entry copying the agent's old
   * hired/reportsTo/heartbeat/budget metadata.
   *
   * Templates with hired=true but not on any project's roster are
   * intentionally orphaned — the user can re-hire them into a project
   * via the UI. Per Q4 lock, there's no global "hired" state.
   */
  private migrateFromLegacy(): RosterIndex {
    const out: RosterIndex = {};
    let templates: LegacyAgentTemplate[] = [];
    let projects: LegacyProject[] = [];
    try {
      if (existsSync(LEGACY_TEMPLATES_FILE)) {
        templates = JSON.parse(readFileSync(LEGACY_TEMPLATES_FILE, "utf-8"));
      }
    } catch { /* empty templates is fine */ }
    try {
      if (existsSync(LEGACY_PROJECTS_FILE)) {
        projects = JSON.parse(readFileSync(LEGACY_PROJECTS_FILE, "utf-8"));
      }
    } catch { /* empty projects is fine */ }

    const tplById = new Map<string, LegacyAgentTemplate>();
    for (const t of templates) tplById.set(t.id, t);

    const now = Date.now();
    let migrated = 0;
    for (const proj of projects) {
      if (!Array.isArray(proj.agentIds)) continue;
      for (const agentId of proj.agentIds) {
        const tpl = tplById.get(agentId);
        const entry: ProjectRoster = {
          projectId: proj.id,
          agentId,
          reportsTo: tpl?.reportsTo,
          heartbeatSchedule: tpl?.heartbeatSchedule,
          heartbeatEnabled: tpl?.heartbeatEnabled,
          budget: tpl?.budget,
          createdAt: now,
          updatedAt: now,
        };
        out[rosterKey(proj.id, agentId)] = entry;
        migrated += 1;
      }
    }
    if (migrated > 0) logger.info(`[migrate] Created ${migrated} roster entries from legacy data`);
    return out;
  }

  private persist(): void {
    writeFileSync(ROSTERS_FILE, JSON.stringify(this.rosters, null, 2), "utf-8");
  }

  /** Get one roster entry. Returns undefined when the agent isn't on
   *  the project's roster. */
  get(projectId: string, agentId: string): ProjectRoster | undefined {
    return this.rosters[rosterKey(projectId, agentId)];
  }

  /** All roster entries for one project. */
  listByProject(projectId: string): ProjectRoster[] {
    return Object.values(this.rosters).filter((r) => r.projectId === projectId);
  }

  /** Every project this agent is on. Cross-project introspection. */
  listByAgent(agentId: string): ProjectRoster[] {
    return Object.values(this.rosters).filter((r) => r.agentId === agentId);
  }

  /** Every agent that appears on at least one project's roster. Dedup
   *  by agentId. Replaces the global AgentTemplate.hired === true
   *  predicate the legacy code used. */
  listRosteredAgentIds(): string[] {
    const seen = new Set<string>();
    for (const r of Object.values(this.rosters)) seen.add(r.agentId);
    return [...seen];
  }

  /** All entries across all projects. */
  listAll(): ProjectRoster[] {
    return Object.values(this.rosters);
  }

  /** Hire an agent into a project. Idempotent — calling twice updates
   *  the entry rather than creating a duplicate. */
  upsert(
    projectId: string,
    agentId: string,
    opts?: { reportsTo?: string; heartbeatSchedule?: string; budget?: ProjectRoster["budget"] },
  ): ProjectRoster {
    const key = rosterKey(projectId, agentId);
    const existing = this.rosters[key];
    const now = Date.now();
    const entry: ProjectRoster = {
      projectId,
      agentId,
      reportsTo: opts?.reportsTo ?? existing?.reportsTo,
      heartbeatSchedule: opts?.heartbeatSchedule ?? existing?.heartbeatSchedule,
      heartbeatEnabled: opts?.heartbeatSchedule
        ? true
        : opts?.heartbeatSchedule === ""
          ? false
          : existing?.heartbeatEnabled,
      budget: opts?.budget ?? existing?.budget,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rosters[key] = entry;
    this.persist();
    return entry;
  }

  /** Patch a roster entry — partial updates. Returns null if absent. */
  patch(projectId: string, agentId: string, patch: Partial<Pick<ProjectRoster, "reportsTo" | "heartbeatSchedule" | "heartbeatEnabled" | "budget">>): ProjectRoster | null {
    const key = rosterKey(projectId, agentId);
    const existing = this.rosters[key];
    if (!existing) return null;
    Object.assign(existing, patch, { updatedAt: Date.now() });
    this.persist();
    return existing;
  }

  /** Fire an agent from a project. Returns true when an entry existed. */
  remove(projectId: string, agentId: string): boolean {
    const key = rosterKey(projectId, agentId);
    if (!(key in this.rosters)) return false;
    delete this.rosters[key];
    this.persist();
    return true;
  }
}
