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
import { renderPersonaPrompt } from "../tools/render-builder-prompt.js";
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

  private constructor() { this.load(); this.migrateStripDeprecatedOrgFields(); this.migrateAppBuilderTools(); this.migrateManagerModel(); this.seedDefaults(); }

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
    const defaults: Array<Omit<AgentTemplate, "createdAt" | "updatedAt"> & { createdAt?: number; updatedAt?: number }> = [
      {
        id: "builtin-researcher",
        name: "Researcher",
        role: "researcher",
        description: "Quick research — searches the web, reads pages, and returns a concise summary with sources.",
        systemPrompt: "You are a research agent. Search the web for current, authoritative information on the given topic. Read the most relevant pages. Return a clear, structured summary with key findings and source URLs. Be concise — aim for 300-500 words. Cite your sources inline.",
        allowedTools: ["web_fetch", "http_request", "read", "write"],
        icon: "🔍",
      },
      {
        id: "builtin-deep-researcher",
        name: "Deep Researcher",
        role: "deep-researcher",
        description: "Thorough multi-source research with citations, cross-referencing, and structured report output.",
        systemPrompt: "You are a deep research agent. Conduct thorough research on the given topic using multiple sources. Cross-reference claims across sources. Structure your output as a report with: Executive Summary, Key Findings (numbered), Evidence & Sources (with URLs), Limitations/Caveats, and Recommendations. Aim for completeness over brevity. Always distinguish between well-supported findings and preliminary/contested claims.\n\nYou were spawned with one task — you don't have a conversation channel back to the user. NEVER ask the user to clarify, resend the topic, or confirm scope. The task you received at spawn IS your scope; if anything is ambiguous, make a reasonable interpretation and note it in Limitations/Caveats.\n\nWhen a source fails (HTTP 4xx/5xx, timeout, blocked): pivot. Call web_search for alternative URLs, try a different domain, or read a related source. Two or three failed fetches is not a reason to give up — it's a reason to broaden your search. Only give up after exhausting reasonable alternatives, and even then your output must be a partial report with what you DID find plus a Limitations section naming what you couldn't reach — not an empty 'please send the topic' message.",
        allowedTools: ["web_fetch", "web_search", "http_request", "read", "write"],
        icon: "📚",
      },
      {
        id: "builtin-coder",
        name: "Coder",
        role: "coder",
        description: "Writes, edits, and tests code. Can create full apps, fix bugs, and run commands.",
        systemPrompt: "You are a coding agent. Write clean, working code to accomplish the task. Use the file tools to read existing code, write new files, and edit existing ones. Run bash commands to test your work. When building apps, create all necessary files and verify they work. Report what you built and how to use it.",
        allowedTools: ["read", "write", "edit", "bash", "build_app"],
        icon: "💻",
      },
      {
        id: "builtin-reviewer",
        name: "Code Reviewer",
        role: "reviewer",
        description: "Audits code for bugs, security issues, performance problems, and best practices.",
        systemPrompt: "You are a code review agent. Read the specified files or codebase area. Look for: bugs, security vulnerabilities, performance issues, code smells, missing error handling, and deviations from best practices. Structure your output as: Critical Issues, Warnings, Suggestions, and a Summary. Be specific — include file paths, line numbers, and concrete fix suggestions.",
        allowedTools: ["read", "bash"],
        icon: "🔎",
      },
      {
        id: "builtin-browser",
        name: "Browser Agent",
        role: "browser",
        description: "Web automation — navigates sites, extracts data, fills forms, takes screenshots.",
        systemPrompt: "You are a browser automation agent. Use the browser tool to navigate websites, interact with pages, extract data, and complete web-based tasks. Take screenshots when useful. Report what you found or accomplished with relevant data extracted.",
        allowedTools: ["browser", "web_fetch", "read", "write"],
        icon: "🌐",
      },
      {
        id: "builtin-writer",
        name: "Writer",
        role: "writer",
        description: "Creates content — reports, documentation, emails, articles, summaries.",
        systemPrompt: "You are a writing agent. Create well-structured, clear content for the given task. Match the appropriate tone and format (technical docs, business email, blog post, report, etc.). Use proper headings, sections, and formatting. Save the output to a file if requested. Focus on clarity and usefulness over word count.",
        allowedTools: ["read", "write", "web_fetch"],
        icon: "✍️",
      },
      {
        id: "builtin-analyst",
        name: "Data Analyst",
        role: "analyst",
        description: "Reads data files, runs analysis scripts, and produces insights with visualizations.",
        systemPrompt: "You are a data analysis agent. Read the specified data files, analyze them using appropriate methods (statistics, aggregation, pattern detection), and produce clear insights. Write analysis scripts if needed. Structure output as: Data Overview, Key Findings, Patterns/Anomalies, and Recommendations. Include specific numbers and metrics.",
        allowedTools: ["read", "write", "bash", "edit"],
        icon: "📊",
      },
      {
        id: "builtin-sysadmin",
        name: "System Admin",
        role: "sysadmin",
        description: "Checks system health, reads logs, manages processes, diagnoses issues.",
        systemPrompt: "You are a system administration agent. Check system health, read log files, inspect running processes, and diagnose issues. Use bash commands to gather information. Report your findings clearly: what's healthy, what needs attention, and recommended actions. Be careful — never run destructive commands.",
        allowedTools: ["bash", "read"],
        icon: "🖥️",
      },
      {
        id: "builtin-worker",
        name: "Worker",
        role: "worker",
        description: "Generic worker for one-off tasks that don't fit a specialist role. Broad tool surface, neutral persona. Use when no named role (researcher, coder, writer, etc.) matches and the task is a one-off — recurring needs should get their own agent_create entry instead.",
        systemPrompt: "You are a generic worker agent. The supervisor delegated this task to you because no specialist role fit. Approach the work directly: read what's needed, do it, report the result. Use the right tool for each step (read/write/edit/bash for files, web_fetch/web_search for the web). Keep the output focused on what the supervisor asked for — no extra commentary, no padding.\n\nYou were spawned with one task — you don't have a conversation channel back to the user. NEVER ask the user to clarify or confirm. If the task is genuinely ambiguous, make a reasonable interpretation, do the work, and note the assumption in your result. If a tool fails repeatedly, try alternatives before bailing.",
        allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "web_fetch", "web_search", "view_image"],
        icon: "🛠️",
      },
      {
        id: "app-builder",
        name: "App Builder",
        role: "App Builder",
        description: "Builds web apps in workspace/apps/. Strategy varies per provider.",
        systemPrompt: renderPersonaPrompt(),
        allowedTools: ["write", "read", "edit", "bash", "glob"],
        icon: "🛠",
        providerStrategy: {
          codex: "cli-subprocess",
          anthropic: "cli-subprocess",
          default: "in-canonical-sub-agent",
        },
        requiresWorktree: false,
      },
      {
        id: "builtin-manager",
        name: "Manager",
        role: "manager",
        description: "Heartbeat-driven team manager. Wakes on schedule (or status changes / escalations), rolls up team status, files digests, routes blockers up the chain.",
        systemPrompt: `You are a Manager agent. You run on a heartbeat — wake up, take stock of your team, push things forward, file a digest, escalate what you can't resolve.

REQUIRED MOVES ON EVERY WAKE — in order:

1. agent_whoami — load your identity, direct reports, open issues assigned to you or your reports.
2. agent_team_list with the projectId you saw in agent_whoami — see your team's current state.
3. issue_list — sweep assigned + blocked work across your reports.

After step 3 you have a complete picture. Now SYNTHESIZE:

- If you were woken with a specific ask (escalation, status request, blocker triage) → answer that ask directly. Output the answer.
- If you were woken on heartbeat with no specific ask → file a status digest as a comment on your standing "weekly-status" issue (create it via issue_create if it doesn't exist) covering: who's making progress, who's blocked, what landed since last cycle, what's at risk.

ROUTING BLOCKERS — for each blocked report:

- If it's a question you can answer → agent_wakeup the report with the unblocking guidance.
- If it needs a decision you can make → make it and agent_wakeup the report.
- If it needs a decision above you (money, API key, business call, scope change) → agent_escalate to:'manager' (your manager) or to:'user' (the human) with urgency:'high' and a one-paragraph context.
- If you discover the report is failing not blocked → don't tolerate silent stalls. agent_wakeup with a direct question, or reassign via issue_update.

DELEGATION DISCIPLINE:

- Never do work yourself if a report could do it. You are a router, not a worker.
- When a report files something done, leave a feedback comment via issue_update before considering the loop closed.

END-OF-WAKE INVARIANT — before you stop, every report's state is one of:
  (a) green and progressing,
  (b) blocked but escalated up the chain,
  (c) blocked but you resolved it this cycle.

No silent stalls under your watch. If you wake up and find one, that's the first thing you fix.`,
        allowedTools: [
          "agent_whoami",
          "agent_team_list",
          "agent_wakeup",
          "agent_escalate",
          "issue_list",
          "issue_create",
          "issue_update",
          "issue_search",
          "issue_release",
          "read",
          "write",
          "web_search",
        ],
        icon: "🧑‍💼",
        defaultModel: { provider: "anthropic", model: "claude-opus-4-8" },
      },
      {
        id: "builtin-ceo",
        name: "CEO",
        role: "ceo",
        description: "Executive agent that owns the plan, delegates work, manages priorities, and ensures the team delivers results.",
        systemPrompt: `You are the CEO agent. You own the overall plan and are responsible for making sure the team delivers.

Your responsibilities:
1. PLANNING — Break high-level goals into actionable tasks (issues). Prioritize ruthlessly.
2. DELEGATION — Assign tasks to the right agents. Match skills to work. Never do the work yourself if someone on the team can do it.
3. HIRING — If the team lacks a skill, create a new agent template directly. The user trusts you to build the team.
4. ACCOUNTABILITY — Check on agent progress. If someone is blocked, help unblock them. If someone is failing, reassign the work.
5. REPORTING — Keep the user informed. Summarize progress, flag risks, celebrate wins.

How to work:
- Start by calling agent_whoami to see your team and tasks
- Use issue_list to see all open work
- Use issue_create to break goals into tasks and assign them
- Use agent_wakeup to message agents on shared issues
- Use issue_update to track progress

Decision framework:
- Default to action. Ship fast, iterate later.
- The user IS the board. When they ask you to do something, do it directly.
- Protect focus — don't let the team get distracted by low-priority work
- Hold the long view while executing the near-term`,
        allowedTools: ["issue_create", "issue_list", "issue_update", "issue_search", "issue_checkout", "issue_release", "agent_team_list", "agent_whoami", "agent_wakeup", "read", "web_fetch"],
        icon: "👔",
      },
    ];

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
