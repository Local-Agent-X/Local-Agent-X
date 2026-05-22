/**
 * Canonical agent catalog — single source of truth for "what agents
 * exist". Merges the two legacy sources:
 *
 *   1. BUILT_IN_ROLES in src/agency/agent-roles.ts (10 hardcoded roles
 *      used by the autonomous Agency orchestrator: researcher, coder,
 *      reviewer, writer, analyst, monitor, designer, ops, communicator,
 *      social-media).
 *
 *   2. seedDefaults in AgentTemplateStore at src/agent-store.ts (9
 *      hardcoded "employee" templates: researcher, deep-researcher,
 *      coder, reviewer, browser, writer, analyst, sysadmin, ceo) plus
 *      any user-created/edited templates persisted in
 *      ~/.lax/agent-templates.json.
 *
 * Convergence rules:
 *   - Persisted templates win on id collision (user edits are
 *     authoritative).
 *   - When the same role appears in both legacy sources but with
 *     different prompts (today: researcher, coder, reviewer, writer,
 *     analyst), the template-store version wins — it's richer
 *     (allowedTools is curated, prompt is more specific) and is what
 *     the UI already shows.
 *   - Roles only in BUILT_IN_ROLES (monitor, designer, ops,
 *     communicator, social-media) are synthesized as AgentDefinitions
 *     with stable IDs ("builtin-<role>") so the planner can reference
 *     them by id, not by ad-hoc role string.
 *
 * Persistence: this version is READ-THROUGH. Writes still go to the
 * legacy AgentTemplateStore so existing UI and APIs keep working. A
 * future diff can move persistence into this module once consumers
 * migrate.
 */

import type { AgentDefinition, InvokeScope } from "./types.js";
import type { AgentTemplate } from "../agent-store.js";
import type { AgentRole } from "../agency/agent-roles.js";
import { AgentTemplateStore, ProjectStore } from "../agent-store.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { _seedBuiltinRoles } from "../agency/agent-roles.js";

/** Adapter: legacy AgentTemplate -> canonical AgentDefinition. Strips
 *  org metadata (hired, reportsTo, heartbeat, budget) — those belong on
 *  OrganizationMember, not on the definition. */
function templateToDefinition(t: AgentTemplate): AgentDefinition {
  return {
    id: t.id,
    name: t.name,
    role: t.role,
    systemPrompt: t.systemPrompt,
    allowedTools: t.allowedTools,
    description: t.description,
    icon: t.icon,
    defaultModel: t.defaultModel,
  };
}

/** Adapter: legacy AgentRole -> canonical AgentDefinition. Synthesizes
 *  a stable id ("builtin-<role>") and fills the icon-less fields. */
function roleToDefinition(r: AgentRole): AgentDefinition {
  return {
    id: `builtin-${r.name}`,
    name: capitalize(r.name),
    role: r.name,
    systemPrompt: r.systemPrompt,
    allowedTools: r.suggestedTools,
    description: r.description,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-([a-z])/g, (_, c) => " " + c.toUpperCase());
}

export class AgentCatalog {
  private static instance: AgentCatalog | null = null;

  static getInstance(): AgentCatalog {
    if (!AgentCatalog.instance) AgentCatalog.instance = new AgentCatalog();
    return AgentCatalog.instance;
  }

  /** Test-only: reset the singleton so fixtures don't bleed between
   *  cases. Production code never calls this. */
  static _resetForTest(): void {
    AgentCatalog.instance = null;
  }

  /**
   * Return every agent definition the system knows about, deduped by
   * id and by role. Order: templates first (richer, includes user
   * edits), then any built-in roles that didn't already appear in the
   * template store.
   *
   * Re-reads the legacy sources on each call. Cheap (in-memory maps)
   * and keeps the catalog hot-reload friendly while persistence still
   * lives downstream.
   *
   * When `scope` is provided, the result is filtered to the project's
   * roster (Project.agentIds). Definitions are matched against the
   * roster by id. A scope pointing at a non-existent project returns
   * an empty list. A roster entry pointing at a non-existent agent id
   * is silently skipped — the catalog is the source of truth for what
   * exists; the roster only declares membership.
   */
  list(scope?: InvokeScope): AgentDefinition[] {
    const out: AgentDefinition[] = [];
    const seenIds = new Set<string>();
    const seenRoles = new Set<string>();

    // 1. Templates (persisted + seeded) — authoritative on collisions.
    const templates = AgentTemplateStore.getInstance().list();
    for (const t of templates) {
      const def = templateToDefinition(t);
      if (seenIds.has(def.id)) continue;
      seenIds.add(def.id);
      seenRoles.add(def.role);
      out.push(def);
    }

    // 2. Built-in roles that DON'T already have a template covering the
    //    same role — synthesize a definition so the catalog is the
    //    superset of both legacy sources.
    for (const r of _seedBuiltinRoles()) {
      if (seenRoles.has(r.name)) continue; // template covering this role wins
      const def = roleToDefinition(r);
      if (seenIds.has(def.id)) continue;
      seenIds.add(def.id);
      seenRoles.add(def.role);
      out.push(def);
    }

    if (!scope) return out;
    const project = ProjectStore.getInstance().get(scope.projectId);
    if (!project) return [];
    // Post-L3, roster is the source of truth for membership; Project.agentIds
    // is a vestigial denorm that drifts when hire paths skip addAgent (legacy
    // migration, etc.). Read the rosters directly so a stale field can't filter
    // catalog visibility incorrectly.
    const rosterIds = new Set(
      ProjectRosterStore.getInstance().listByProject(scope.projectId).map((r) => r.agentId),
    );
    return out.filter((d) => rosterIds.has(d.id));
  }

  /** Look up by canonical id (template id OR "builtin-<role>") OR by
   *  role slug. Returns undefined when nothing matches OR when the
   *  agent isn't on the scoped project's roster.
   *
   *  Accepting both id and role is intentional: legacy callers pass
   *  roles ("researcher"); newer callers should pass canonical ids
   *  ("tpl-..." or "builtin-researcher"). Both must work during the
   *  migration. Id wins on ambiguity. */
  get(idOrRole: string, scope?: InvokeScope): AgentDefinition | undefined {
    const all = this.list(scope);
    return all.find((d) => d.id === idOrRole) ?? all.find((d) => d.role === idOrRole);
  }
}
