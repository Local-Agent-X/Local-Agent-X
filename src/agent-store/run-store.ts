// Agent run history — one JSON file per run under ~/.lax/agent-runs/.
//
// Status vocabulary aligned with the canonical-loop's TerminalState
// (F13). Pre-F13 records on disk used {done, error, timeout};
// migrateRunStatus normalises them on read so callers always see the
// new vocabulary.

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, ensureDirs } from "./paths.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agent-store");

export interface AgentRun {
  id: string;
  parentAgentId: string | null;
  sessionId: string;
  name: string;
  role: string;
  task: string;
  systemPrompt: string;
  status: "working" | "succeeded" | "failed" | "cancelled";
  output: string[];
  result: string;
  toolsUsed: string[];
  tokensUsed: number;
  startedAt: number;
  completedAt: number;
  error?: string;
  /** Sub-classification for terminal `failed` — currently only
   *  "timeout" is meaningful (wall-clock ceiling vs in-task error). */
  reason?: "timeout";
  /** AgentDefinition id this run was spawned from. Optional because
   *  ad-hoc runs (operations/executor phase agents, legacy records
   *  pre-chunk-3) have no template. Set by handler-events.ts from the
   *  agent-spawn event's templateId so callers like the stall watchdog
   *  can find "the most recent run for agent X" without scanning every
   *  field. */
  templateId?: string;
}

// Normalise persisted records written under the pre-F13 vocabulary.
// Old strings → new strings; "timeout" becomes `failed + reason="timeout"`.
// Idempotent: applying twice is a no-op.
function migrateRunStatus(run: AgentRun): AgentRun {
  const legacy = run.status as unknown as string;
  if (legacy === "done") return { ...run, status: "succeeded" };
  if (legacy === "error") return { ...run, status: "failed" };
  if (legacy === "timeout") return { ...run, status: "failed", reason: "timeout" };
  return run;
}

function migrateStatusFilter(s: string): string {
  if (s === "done") return "succeeded";
  if (s === "error" || s === "timeout") return "failed";
  return s;
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
    try { return migrateRunStatus(JSON.parse(readFileSync(p, "utf-8")) as AgentRun); }
    catch (e) {
      // Corrupted run file surfaces as "not found", which then routes
      // the agent through the same "no such run" path as a truly
      // missing file — hides the corruption. Log so the operator can
      // recover the JSON or delete the bad file.
      logger.warn(`failed to read agent run ${id}: ${(e as Error).message}`);
      return null;
    }
  }

  list(opts?: { limit?: number; offset?: number; sessionId?: string; status?: string }): { runs: AgentRun[]; total: number } {
    ensureDirs();
    const files = readdirSync(RUNS_DIR).filter(f => f.endsWith(".json"));

    let runs: AgentRun[] = [];
    for (const f of files) {
      try {
        const run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8")) as AgentRun;
        runs.push(migrateRunStatus(run));
      } catch {}
    }
    runs.sort((a, b) => b.startedAt - a.startedAt);

    // Filter — accept legacy vocabulary on the `status` query string so a
    // UI request for `?status=done` still matches migrated records.
    if (opts?.sessionId) runs = runs.filter(r => r.sessionId === opts.sessionId);
    if (opts?.status) {
      const want = migrateStatusFilter(opts.status);
      runs = runs.filter(r => r.status === want);
    }

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
