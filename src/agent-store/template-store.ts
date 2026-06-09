// Agent templates — the catalog of personas (Researcher, Coder,
// Reviewer, etc.). Persisted to ~/.lax/agent-templates.json with
// built-in defaults seeded on first run.
//
// Per-template provider strategy lets the canonical-op dispatcher decide
// whether to spawn a CLI subprocess or run in-process. Optional; templates
// without it use the lane default.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { TEMPLATES_FILE } from "./paths.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { builtInTemplateDefaults } from "./template-defaults.js";
import { createLogger } from "../logger.js";
import type { AgentModelPin } from "../agents/types.js";

const logger = createLogger("agent-store");

export type AgentExecStrategy = "cli-subprocess" | "in-canonical-sub-agent";

export interface AgentProviderStrategy {
  [providerId: string]: AgentExecStrategy | undefined;
  default?: AgentExecStrategy;
}

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  allowedTools: string[];
  description: string;
  icon?: string;
  /** True = spawn this agent inside an isolated git worktree of the LAX
   *  repo. Default false. See AgentDefinition.requiresWorktree for the
   *  canonical doc and AUDIT Cluster 11 for the migration. */
  requiresWorktree?: boolean;
  /** Template-level default provider+model pin. Mirrors
   *  AgentDefinition.defaultModel — the catalog adapter copies it
   *  through. Chunk 4 owns the per-template seed values; this chunk
   *  only adds the field. */
  defaultModel?: AgentModelPin;
  providerStrategy?: AgentProviderStrategy;
  // Note: hired / reportsTo / heartbeatSchedule / heartbeatEnabled /
  // budget moved to ProjectRoster (src/project-rosters.ts) in the L3
  // persistence split — those are per-project membership facts, not
  // definition facts. Same agent in two projects has independent
  // metadata in each.
  createdAt: number;
  updatedAt: number;
}

export class AgentTemplateStore {
  private static instance: AgentTemplateStore;
  private templates: AgentTemplate[] = [];

  private constructor() { this.load(); this.migrateStripDeprecatedOrgFields(); this.migrateAppBuilderTools(); this.migrateAppBuilderCodexStrategy(); this.migrateManagerModel(); this.seedDefaults(); }

  /**
   * Strip deprecated org-membership fields from persisted templates.
   *
   * The L3 split moved `hired / reportsTo / heartbeatSchedule /
   * heartbeatEnabled / budget` from AgentTemplate to ProjectRoster, but
   * pre-L3 JSON on disk still carries them. The UI used to read
   * `template.hired` to render the HIRED badge, which lied whenever the
   * field outlived its roster counterpart (template hired flag never
   * cleared, no matching roster entry). Idempotent: a clean template is
   * left alone.
   */
  private migrateStripDeprecatedOrgFields(): void {
    const deprecated = ["hired", "reportsTo", "heartbeatSchedule", "heartbeatEnabled", "budget"] as const;
    let touched = false;
    for (const t of this.templates) {
      const tt = t as unknown as Record<string, unknown>;
      for (const k of deprecated) {
        if (k in tt) { delete tt[k]; touched = true; }
      }
    }
    if (touched) {
      this.persist();
      logger.info("[agents] stripped deprecated org-membership fields from persisted templates");
    }
  }

  /**
   * Older seeds of the `app-builder` template included `list_directory` in
   * allowedTools — that tool isn't registered. The adapter substituted
   * `glob` at runtime as a workaround; this fixes the template in place.
   * Idempotent: a template already using `glob` is left alone.
   */
  private migrateAppBuilderTools(): void {
    const t = this.templates.find(x => x.id === "app-builder");
    if (!t) return;
    const idx = t.allowedTools.indexOf("list_directory");
    if (idx < 0) return;
    if (t.allowedTools.includes("glob")) {
      t.allowedTools.splice(idx, 1);
    } else {
      t.allowedTools[idx] = "glob";
    }
    t.updatedAt = Date.now();
    this.persist();
    logger.info("[agents] migrated app-builder template: list_directory → glob");
  }

  /**
   * Move codex builds off the cli-subprocess path onto the in-canonical
   * default (HTTP, like grok). The codex CLI's advantage was the tuned
   * gpt-5.3-codex model, retired by OpenAI; gpt-5.5 in the codex CLI over-plans
   * and overruns the build wall-clock ceiling. Dropping the persisted codex
   * override lets it inherit `default`. anthropic keeps cli-subprocess (the
   * claude CLI stays fast). Idempotent: no codex override → left alone.
   */
  private migrateAppBuilderCodexStrategy(): void {
    const t = this.templates.find(x => x.id === "app-builder");
    if (t?.providerStrategy?.codex !== "cli-subprocess") return;
    delete t.providerStrategy.codex;
    t.updatedAt = Date.now();
    this.persist();
    logger.info("[agents] migrated app-builder: codex build path cli-subprocess → in-canonical");
  }

  /**
   * Bump the manager template's default model when the prior flagship
   * (Opus 4.7) ships a successor (Opus 4.8). Only rewrites templates still
   * pinned to the OLD default — a user who picked a different model keeps it.
   * Idempotent: already on 4.8 (or anything else) → left alone.
   */
  private migrateManagerModel(): void {
    const t = this.templates.find(x => x.id === "builtin-manager");
    if (!t?.defaultModel) return;
    if (t.defaultModel.provider !== "anthropic" || t.defaultModel.model !== "claude-opus-4-7") return;
    t.defaultModel = { provider: "anthropic", model: "claude-opus-4-8" };
    t.updatedAt = Date.now();
    this.persist();
    logger.info("[agents] migrated builtin-manager default model: claude-opus-4-7 → claude-opus-4-8");
  }

  static getInstance(): AgentTemplateStore {
    if (!AgentTemplateStore.instance) AgentTemplateStore.instance = new AgentTemplateStore();
    return AgentTemplateStore.instance;
  }

  private load(): void {
    try {
      if (existsSync(TEMPLATES_FILE)) {
        this.templates = JSON.parse(readFileSync(TEMPLATES_FILE, "utf-8"));
      }
    } catch { this.templates = []; }
  }

  private persist(): void {
    writeFileSync(TEMPLATES_FILE, JSON.stringify(this.templates, null, 2), "utf-8");
  }

  list(): AgentTemplate[] {
    return [...this.templates].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): AgentTemplate | null {
    return this.templates.find(t => t.id === id) || null;
  }

  /** Case-insensitive, whitespace-trimmed lookup. Used by agent_create
   *  to enforce one agent per display name. Same pattern as project-store
   *  uses — keeps the natural-key invariant at the store layer instead of
   *  scattered per-caller checks. */
  findByName(name: string): AgentTemplate | null {
    const target = name.trim().toLowerCase();
    if (!target) return null;
    return this.templates.find(t => t.name.trim().toLowerCase() === target) || null;
  }

  create(template: Omit<AgentTemplate, "id" | "createdAt" | "updatedAt">): AgentTemplate {
    const existing = this.findByName(template.name);
    if (existing) {
      const err = new Error(`Agent name '${template.name}' already exists (id: ${existing.id})`) as Error & { code?: string; existingId?: string };
      err.code = "AGENT_NAME_EXISTS";
      err.existingId = existing.id;
      throw err;
    }
    const id = "tpl-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
    const full: AgentTemplate = {
      ...template,
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.templates.push(full);
    this.persist();
    return full;
  }

  update(id: string, partial: Partial<AgentTemplate>): AgentTemplate | null {
    const idx = this.templates.findIndex(t => t.id === id);
    if (idx < 0) return null;
    this.templates[idx] = { ...this.templates[idx], ...partial, id, updatedAt: Date.now() };
    this.persist();
    return this.templates[idx];
  }

  delete(id: string): boolean {
    const len = this.templates.length;
    this.templates = this.templates.filter(t => t.id !== id);
    if (this.templates.length < len) { this.persist(); return true; }
    return false;
  }

  /** Seed built-in templates on first run (won't overwrite user edits) */
  private seedDefaults(): void {
    const defaults = builtInTemplateDefaults();

    const existingIds = new Set(this.templates.map(t => t.id));
    let added = 0;
    for (const d of defaults) {
      if (!existingIds.has(d.id)) {
        this.templates.push({ ...d, createdAt: Date.now(), updatedAt: Date.now() } as AgentTemplate);
        added++;
      }
    }
    if (added > 0) {
      this.persist();
      logger.info(`[agents] Seeded ${added} default agent templates`);
    }
  }

  /**
   * Backward-compat shim — "agents that are rostered in any project."
   * Pre-L3 this was templates with `hired: true`; post-L3 hire is
   * per-project so the equivalent question is "is this template on
   * any project's roster?" Use ProjectRosterStore.listByProject when
   * the caller knows which project; this method is for legacy global
   * views that haven't migrated yet (Team tab, agent_team_list,
   * agent_whoami).
   */
  listHired(): AgentTemplate[] {
    const rosteredIds = new Set(ProjectRosterStore.getInstance().listRosteredAgentIds());
    return this.templates.filter((t) => rosteredIds.has(t.id));
  }
}
