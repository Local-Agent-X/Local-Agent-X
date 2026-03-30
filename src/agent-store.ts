/**
 * Agent Store — persists agent run history and custom templates.
 *
 * Run history: ~/.sax/agent-runs/<id>.json  (one file per run)
 * Templates:   ~/.sax/agent-templates.json  (single file)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SAX_DIR = join(homedir(), ".sax");
const RUNS_DIR = join(SAX_DIR, "agent-runs");
const TEMPLATES_FILE = join(SAX_DIR, "agent-templates.json");

function ensureDirs(): void {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
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
    const id = "tpl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
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
      console.log(`[agents] Seeded ${added} default agent templates`);
    }
  }
}
