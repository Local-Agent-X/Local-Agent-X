/**
 * Agent Store — persists agent run history and custom templates.
 *
 * Run history: ~/.lax/agent-runs/<id>.json  (one file per run)
 * Templates:   ~/.lax/agent-templates.json  (single file)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import { createLogger } from "./logger.js";
const logger = createLogger("agent-store");

const LAX_DIR = join(homedir(), ".lax");
const RUNS_DIR = join(LAX_DIR, "agent-runs");
const TEMPLATES_FILE = join(LAX_DIR, "agent-templates.json");
const PROJECTS_FILE = join(LAX_DIR, "agent-projects.json");

function ensureDirs(): void {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

// ── Projects (scoped isolation) ──────────────────────────

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
    const id = "proj-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
    const full: Project = { ...project, id, createdAt: Date.now(), updatedAt: Date.now() };
    this.projects.push(full);
    this.persist();
    return full;
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

  /** Get which project an agent belongs to */
  getAgentProject(agentId: string): Project | null {
    return this.projects.find(p => p.agentIds.includes(agentId)) || null;
  }

  /** Check if two agents are in the same project */
  sameProject(agentId1: string, agentId2: string): boolean {
    const p1 = this.getAgentProject(agentId1);
    const p2 = this.getAgentProject(agentId2);
    if (!p1 || !p2) return false;
    return p1.id === p2.id;
  }
}

// ── Agent Run History ──────────────────────────────────────

export interface AgentRun {
  id: string;
  parentAgentId: string | null;
  sessionId: string;
  name: string;
  role: string;
  task: string;
  systemPrompt: string;
  status: "working" | "done" | "error" | "cancelled" | "timeout";
  output: string[];
  result: string;
  toolsUsed: string[];
  tokensUsed: number;
  startedAt: number;
  completedAt: number;
  error?: string;
}

export class AgentRunStore {
  private static instance: AgentRunStore;

  private constructor() { ensureDirs(); }

  static getInstance(): AgentRunStore {
    if (!AgentRunStore.instance) AgentRunStore.instance = new AgentRunStore();
    return AgentRunStore.instance;
  }

  save(run: AgentRun): void {
    ensureDirs();
    writeFileSync(join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2), "utf-8");
  }

  get(id: string): AgentRun | null {
    const p = join(RUNS_DIR, `${id}.json`);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  }

  list(opts?: { limit?: number; offset?: number; sessionId?: string; status?: string }): { runs: AgentRun[]; total: number } {
    ensureDirs();
    let files = readdirSync(RUNS_DIR).filter(f => f.endsWith(".json"));

    // Load all runs (sorted by most recent first)
    let runs: AgentRun[] = [];
    for (const f of files) {
      try {
        const run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8")) as AgentRun;
        runs.push(run);
      } catch {}
    }
    runs.sort((a, b) => b.startedAt - a.startedAt);

    // Filter
    if (opts?.sessionId) runs = runs.filter(r => r.sessionId === opts.sessionId);
    if (opts?.status) runs = runs.filter(r => r.status === opts.status);

    const total = runs.length;
    const offset = opts?.offset || 0;
    const limit = opts?.limit || 50;
    runs = runs.slice(offset, offset + limit);

    return { runs, total };
  }

  /** Get parent/child tree for a session */
  getTree(sessionId: string): AgentRun[] {
    const { runs } = this.list({ sessionId, limit: 500 });
    return runs;
  }

  /** Get children of a specific agent */
  getChildren(parentAgentId: string): AgentRun[] {
    const { runs } = this.list({ limit: 500 });
    return runs.filter(r => r.parentAgentId === parentAgentId);
  }

  delete(id: string): boolean {
    const p = join(RUNS_DIR, `${id}.json`);
    if (!existsSync(p)) return false;
    try { unlinkSync(p); return true; } catch { return false; }
  }

  clearAll(): number {
    ensureDirs();
    const files = readdirSync(RUNS_DIR).filter(f => f.endsWith(".json"));
    let count = 0;
    for (const f of files) {
      try { unlinkSync(join(RUNS_DIR, f)); count++; } catch {}
    }
    return count;
  }
}

// ── Agent Templates ────────────────────────────────────────

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  allowedTools: string[];
  description: string;
  icon?: string;
  // Persistent agent fields (template becomes "hired" employee)
  hired?: boolean;           // true = this is an active employee, not just a template
  reportsTo?: string;        // ID of the agent this one reports to (hierarchy)
  heartbeatSchedule?: string; // cron expression for wake-up schedule (e.g. "every 4h")
  heartbeatEnabled?: boolean;
  budget?: { maxPerMonth: number; spent: number; resetAt: number };
  createdAt: number;
  updatedAt: number;
}

// ── Issues / Tasks ──

export type IssueStatus = "open" | "in-progress" | "blocked" | "done" | "cancelled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface IssueComment {
  id: string;
  author: string;       // agent ID or "user"
  content: string;
  createdAt: number;
}

export interface Issue {
  id: string;            // e.g. "SAX-1"
  title: string;
  description: string;
  assignee: string;      // agent template ID
  status: IssueStatus;
  priority: IssuePriority;
  project?: string;
  parentIssue?: string;  // for sub-tasks
  lockedBy?: string;     // agent ID that has checkout lock
  lockedAt?: number;     // when lock was acquired
  projectId?: string;    // scoped to a project (agents can only see issues in their project)
  blockedBy?: string[];  // issue IDs this is waiting on
  comments: IssueComment[];
  needsApproval?: boolean;  // true = sitting in inbox
  approvalType?: string;    // "hire" | "action" | "spend" | "deploy"
  approvalData?: Record<string, unknown>;  // context for the approval
  createdBy: string;     // who created it (agent ID or "user")
  createdAt: number;
  updatedAt: number;
}

export class AgentTemplateStore {
  private static instance: AgentTemplateStore;
  private templates: AgentTemplate[] = [];

  private constructor() { this.load(); this.seedDefaults(); }

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

  create(template: Omit<AgentTemplate, "id" | "createdAt" | "updatedAt">): AgentTemplate {
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
        systemPrompt: "You are a deep research agent. Conduct thorough research on the given topic using multiple sources. Cross-reference claims across sources. Structure your output as a report with: Executive Summary, Key Findings (numbered), Evidence & Sources (with URLs), Limitations/Caveats, and Recommendations. Aim for completeness over brevity. Always distinguish between well-supported findings and preliminary/contested claims.",
        allowedTools: ["web_fetch", "http_request", "read", "write"],
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
- The user IS the board. When they ask you to do something, do it directly — don't create approval requests for things they just asked for.
- Protect focus — don't let the team get distracted by low-priority work
- Hold the long view while executing the near-term`,
        allowedTools: ["issue_create", "issue_list", "issue_update", "issue_search", "issue_checkout", "issue_release", "agent_team_list", "agent_whoami", "agent_wakeup", "read", "web_fetch"],
        icon: "👔",
      },
    ];

    // Only seed templates that don't already exist (by ID)
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

  /** Get only hired (persistent) agents */
  listHired(): AgentTemplate[] {
    return this.templates.filter(t => t.hired);
  }

  /** Hire an agent (activate a template as a persistent employee) */
  hire(id: string, opts?: { reportsTo?: string; heartbeatSchedule?: string }): AgentTemplate | null {
    const tpl = this.get(id);
    if (!tpl) return null;
    tpl.hired = true;
    tpl.reportsTo = opts?.reportsTo;
    tpl.heartbeatSchedule = opts?.heartbeatSchedule;
    tpl.heartbeatEnabled = !!opts?.heartbeatSchedule;
    tpl.updatedAt = Date.now();
    this.persist();
    return tpl;
  }

  /** Fire an agent (deactivate) */
  fire(id: string): boolean {
    const tpl = this.get(id);
    if (!tpl) return false;
    tpl.hired = false;
    tpl.heartbeatEnabled = false;
    tpl.updatedAt = Date.now();
    this.persist();
    return true;
  }
}

// ── Issue Store ──────────────────────────────────────────

const ISSUES_FILE = join(LAX_DIR, "agent-issues.json");

export class IssueStore {
  private static instance: IssueStore;
  private issues: Issue[] = [];
  private counter = 0;

  private constructor() { this.load(); }

  static getInstance(): IssueStore {
    if (!IssueStore.instance) IssueStore.instance = new IssueStore();
    return IssueStore.instance;
  }

  private load(): void {
    try {
      if (existsSync(ISSUES_FILE)) {
        this.issues = JSON.parse(readFileSync(ISSUES_FILE, "utf-8"));
        // Derive counter from highest existing ID. Accept both legacy "SAX-N"
        // and new "LAX-N" so existing issue files continue to work after the
        // rebrand. New issues are created with the LAX- prefix below.
        for (const i of this.issues) {
          const num = parseInt(i.id.replace(/^(SAX|LAX)-/, ""), 10);
          if (num > this.counter) this.counter = num;
        }
      }
    } catch { this.issues = []; }
  }

  private persist(): void {
    writeFileSync(ISSUES_FILE, JSON.stringify(this.issues, null, 2), "utf-8");
  }

  create(issue: Omit<Issue, "id" | "comments" | "createdAt" | "updatedAt">): Issue {
    this.counter++;
    const full: Issue = {
      ...issue,
      id: `LAX-${this.counter}`,
      comments: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.issues.push(full);
    this.persist();
    return full;
  }

  get(id: string): Issue | null {
    return this.issues.find(i => i.id === id) || null;
  }

  list(opts?: { assignee?: string; status?: IssueStatus; needsApproval?: boolean; project?: string }): Issue[] {
    let result = [...this.issues];
    if (opts?.assignee) result = result.filter(i => i.assignee === opts.assignee);
    if (opts?.status) result = result.filter(i => i.status === opts.status);
    if (opts?.needsApproval !== undefined) result = result.filter(i => !!i.needsApproval === opts.needsApproval);
    if (opts?.project) result = result.filter(i => i.project === opts.project);
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get inbox: issues needing approval */
  inbox(): Issue[] {
    return this.list({ needsApproval: true });
  }

  update(id: string, partial: Partial<Issue>): Issue | null {
    const issue = this.get(id);
    if (!issue) return null;
    Object.assign(issue, partial, { id, updatedAt: Date.now() });
    this.persist();
    return issue;
  }

  /** Add a comment to an issue */
  comment(id: string, author: string, content: string): IssueComment | null {
    const issue = this.get(id);
    if (!issue) return null;
    const c: IssueComment = {
      id: `c-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      author, content, createdAt: Date.now(),
    };
    issue.comments.push(c);
    issue.updatedAt = Date.now();
    this.persist();
    return c;
  }

  /** Approve an issue (clears needsApproval, sets status to open/in-progress) */
  approve(id: string): Issue | null {
    const issue = this.get(id);
    if (!issue) return null;
    issue.needsApproval = false;
    if (issue.status === "open") issue.status = "in-progress";
    issue.updatedAt = Date.now();
    this.persist();
    return issue;
  }

  /** Reject an issue (clears needsApproval, sets status to cancelled) */
  reject(id: string, reason?: string): Issue | null {
    const issue = this.get(id);
    if (!issue) return null;
    issue.needsApproval = false;
    issue.status = "cancelled";
    if (reason) {
      this.comment(id, "user", `Rejected: ${reason}`);
    }
    issue.updatedAt = Date.now();
    this.persist();
    return issue;
  }

  delete(id: string): boolean {
    const len = this.issues.length;
    this.issues = this.issues.filter(i => i.id !== id);
    if (this.issues.length < len) { this.persist(); return true; }
    return false;
  }

  /** Checkout: lock an issue so only one agent works on it */
  checkout(id: string, agentId: string): Issue | null {
    const issue = this.get(id);
    if (!issue) return null;
    if (issue.lockedBy && issue.lockedBy !== agentId) return null; // Already locked by someone else
    issue.lockedBy = agentId;
    issue.lockedAt = Date.now();
    if (issue.status === "open") issue.status = "in-progress";
    issue.updatedAt = Date.now();
    this.persist();
    return issue;
  }

  /** Release: unlock an issue */
  release(id: string, agentId: string): boolean {
    const issue = this.get(id);
    if (!issue) return false;
    if (issue.lockedBy && issue.lockedBy !== agentId) return false; // Not yours to release
    issue.lockedBy = undefined;
    issue.lockedAt = undefined;
    issue.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /** Search issues by keyword in title + description */
  search(query: string): Issue[] {
    const q = query.toLowerCase();
    return this.issues.filter(i =>
      i.title.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q) ||
      i.comments.some(c => c.content.toLowerCase().includes(q))
    ).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get stats for dashboard */
  stats(): { total: number; open: number; inProgress: number; blocked: number; done: number; pendingApproval: number } {
    return {
      total: this.issues.length,
      open: this.issues.filter(i => i.status === "open").length,
      inProgress: this.issues.filter(i => i.status === "in-progress").length,
      blocked: this.issues.filter(i => i.status === "blocked").length,
      done: this.issues.filter(i => i.status === "done").length,
      pendingApproval: this.issues.filter(i => i.needsApproval).length,
    };
  }
}
