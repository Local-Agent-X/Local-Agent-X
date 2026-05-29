// Project store — scoped isolation for agents. Projects hold a roster of
// agent template IDs plus optional secret/tool restrictions. Persisted
// to ~/.lax/agent-projects.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PROJECTS_FILE } from "./paths.js";
import { ProjectRosterStore } from "../project-rosters.js";

export interface Project {
  id: string;
  name: string;
  description: string;
  workspace?: string;          // project-specific workspace directory
  agentIds: string[];          // agent template IDs assigned to this project
  secretKeys?: string[];       // which secrets this project can access
  allowedTools?: string[];     // tool restrictions for this project's agents
  createdAt: number;
  updatedAt: number;
}

export class ProjectStore {
  private static instance: ProjectStore;
  private projects: Project[] = [];

  private constructor() { this.load(); this.seedStarterTemplates(); }

  static getInstance(): ProjectStore {
    if (!ProjectStore.instance) ProjectStore.instance = new ProjectStore();
    return ProjectStore.instance;
  }

  /** Seed starter project templates on first run */
  private seedStarterTemplates(): void {
    if (this.projects.length > 0) return; // Already has projects
    // Don't auto-create — just make templates available via API
  }

  private load(): void {
    try {
      if (existsSync(PROJECTS_FILE)) {
        this.projects = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
      }
    } catch { this.projects = []; }
  }

  private persist(): void {
    writeFileSync(PROJECTS_FILE, JSON.stringify(this.projects, null, 2), "utf-8");
  }

  create(project: Omit<Project, "id" | "createdAt" | "updatedAt">): Project {
    const existing = this.findByName(project.name);
    if (existing) {
      const err = new Error(`Project name '${project.name}' already exists (id: ${existing.id})`) as Error & { code?: string; existingId?: string };
      err.code = "PROJECT_NAME_EXISTS";
      err.existingId = existing.id;
      throw err;
    }
    const id = "proj-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
    const full: Project = { ...project, id, createdAt: Date.now(), updatedAt: Date.now() };
    this.projects.push(full);
    this.persist();
    return full;
  }

  /** Case-insensitive, whitespace-trimmed name lookup. Used by the
   *  project_create tool and the HTTP POST /api/projects route to enforce
   *  unique project names — `create()` also throws on collision as a
   *  defense-in-depth backstop. The MCP path in particular relied on this
   *  because Claude CLI's multi-step tool loop kept re-issuing
   *  project_create after each step's text reply (the friendly "want me
   *  to add agents?" tool result read like incomplete work), and the
   *  store was happily minting a fresh proj-... id every time. */
  findByName(name: string): Project | null {
    const target = name.trim().toLowerCase();
    if (!target) return null;
    return this.projects.find(p => p.name.trim().toLowerCase() === target) || null;
  }

  get(id: string): Project | null {
    return this.projects.find(p => p.id === id) || null;
  }

  list(): Project[] {
    return [...this.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  update(id: string, partial: Partial<Project>): Project | null {
    const p = this.projects.find(p => p.id === id);
    if (!p) return null;
    Object.assign(p, partial, { id, updatedAt: Date.now() });
    this.persist();
    return p;
  }

  delete(id: string): boolean {
    const len = this.projects.length;
    this.projects = this.projects.filter(p => p.id !== id);
    if (this.projects.length < len) { this.persist(); return true; }
    return false;
  }

  /** Add an agent to a project */
  addAgent(projectId: string, agentId: string): boolean {
    const p = this.get(projectId);
    if (!p) return false;
    if (!p.agentIds.includes(agentId)) {
      p.agentIds.push(agentId);
      p.updatedAt = Date.now();
      this.persist();
    }
    return true;
  }

  /** Remove an agent from a project */
  removeAgent(projectId: string, agentId: string): boolean {
    const p = this.get(projectId);
    if (!p) return false;
    p.agentIds = p.agentIds.filter(id => id !== agentId);
    p.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /** Get which project an agent belongs to.
   *
   * Post-L3, ProjectRosterStore is the source of truth for membership;
   * `Project.agentIds` is a vestigial denorm that drifted out of sync
   * (legacy migrations + the create endpoint accepting seed agentIds
   * both write rosters without rewriting the field in lockstep). Reads
   * go through the roster so getAgentProject can't lie even when the
   * field on disk is stale. Callers that need every project an agent
   * is in should use ProjectRosterStore.listByAgent directly. */
  getAgentProject(agentId: string): Project | null {
    const rosters = ProjectRosterStore.getInstance().listByAgent(agentId);
    if (rosters.length === 0) return null;
    return this.get(rosters[0].projectId);
  }

  /** Check if two agents are in the same project */
  sameProject(agentId1: string, agentId2: string): boolean {
    const p1 = this.getAgentProject(agentId1);
    const p2 = this.getAgentProject(agentId2);
    if (!p1 || !p2) return false;
    return p1.id === p2.id;
  }
}
