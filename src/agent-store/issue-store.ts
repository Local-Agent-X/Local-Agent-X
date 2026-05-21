// Issue/task store. Issues are LAX-N-prefixed, persisted in a single
// JSON file. Checkout/release is the cooperative lock so two agents
// don't pick up the same issue. Legacy SAX-N prefix is accepted on read
// for installs predating the rebrand; new IDs use LAX-.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ISSUES_FILE } from "./paths.js";

export type IssueStatus = "open" | "in-progress" | "blocked" | "done" | "cancelled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface IssueComment {
  id: string;
  author: string;       // agent ID or "user"
  content: string;
  createdAt: number;
}

export interface Issue {
  id: string;            // e.g. "LAX-1"
  title: string;
  description: string;
  assignee: string;      // agent template ID
  status: IssueStatus;
  priority: IssuePriority;
  project?: string;
  parentIssue?: string;  // for sub-tasks
  lockedBy?: string;     // agent ID that has checkout lock
  lockedAt?: number;     // when lock was acquired
  projectId?: string;    // scoped to a project (agents only see issues in their project)
  blockedBy?: string[];  // issue IDs this is waiting on
  comments: IssueComment[];
  createdBy: string;     // who created it (agent ID or "user")
  createdAt: number;
  updatedAt: number;
}

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
        // Derive counter from highest existing ID. Accept both legacy
        // "SAX-N" and new "LAX-N" so existing issue files continue to
        // work after the rebrand. New issues are created with LAX-.
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

  list(opts?: { assignee?: string; status?: IssueStatus; project?: string }): Issue[] {
    let result = [...this.issues];
    if (opts?.assignee) result = result.filter(i => i.assignee === opts.assignee);
    if (opts?.status) result = result.filter(i => i.status === opts.status);
    if (opts?.project) result = result.filter(i => i.project === opts.project);
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
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
    if (issue.lockedBy && issue.lockedBy !== agentId) return null;
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
    if (issue.lockedBy && issue.lockedBy !== agentId) return false;
    issue.lockedBy = undefined;
    issue.lockedAt = undefined;
    issue.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /** Search issues by keyword in title + description + comments */
  search(query: string): Issue[] {
    const q = query.toLowerCase();
    return this.issues.filter(i =>
      i.title.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q) ||
      i.comments.some(c => c.content.toLowerCase().includes(q)),
    ).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get stats for dashboard */
  stats(): { total: number; open: number; inProgress: number; blocked: number; done: number } {
    return {
      total: this.issues.length,
      open: this.issues.filter(i => i.status === "open").length,
      inProgress: this.issues.filter(i => i.status === "in-progress").length,
      blocked: this.issues.filter(i => i.status === "blocked").length,
      done: this.issues.filter(i => i.status === "done").length,
    };
  }
}
