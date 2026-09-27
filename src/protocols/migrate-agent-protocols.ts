/**
 * One-time move of agent-authored catalog protocols into learned drafts.
 *
 * Before the review fork proposed drafts, it wrote straight into
 * workspace/protocols/custom.json. This moves every entry stamped
 * `source.authoredBy === "agent"` into a reviewed-procedure draft the user can
 * keep or discard, and removes it from custom.json. User-authored entries and
 * entries of unknown authorship are left exactly where they are.
 *
 * Nothing is lost: custom.json is copied to a timestamped backup before any
 * write, and a draft only replaces a catalog entry after it was created. A
 * migrated proposal carries outcome "unverified", so it never counts as
 * independent evidence — it activates only when the user keeps it.
 *
 * Not run automatically. scripts/migrate-agent-protocols.ts runs it by hand.
 */
import { copyFileSync, existsSync } from "node:fs";
import type { Protocol } from "./types.js";
import { customProtocolsPath, loadCustomProtocols, saveCustomProtocols } from "./builder.js";
import { catalogReadFailureCount } from "./loader.js";
import { proposeReviewedProcedure } from "./learned-review-drafting.js";

const MIGRATED_SESSION = "migrated-catalog";

export interface AgentProtocolMigrationPlan {
  move: Array<{ from: string; to: string }>;
  keep: string[];
  unmovable: Array<{ name: string; reason: string }>;
}

export interface AgentProtocolMigrationReport extends AgentProtocolMigrationPlan {
  backupPath: string | null;
  migrated: Array<{ from: string; to: string; candidateId: string }>;
}

export interface AgentProtocolMigrationOptions {
  now?: number;
  /** Tools the authoring session's turns called — the draft's capability
   *  evidence. Without it a kept draft would confine a run to no tools. */
  toolEvidenceForSession?: (sessionId: string) => Promise<string[]> | string[];
}

function procedureName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}

function bodyOf(protocol: Protocol): string {
  if (typeof protocol.body === "string" && protocol.body.trim()) return protocol.body;
  const steps = (protocol.steps ?? []).map((step, index) => `${index + 1}. ${step.instruction}`);
  const rules = (protocol.rules ?? []).map((rule) => `- ${rule}`);
  return [
    ...(steps.length ? ["## Steps", "", ...steps, ""] : []),
    ...(rules.length ? ["## Rules", "", ...rules] : []),
  ].join("\n").trim();
}

export function planAgentProtocolMigration(protocols: Protocol[] = loadCustomProtocols()): AgentProtocolMigrationPlan {
  const plan: AgentProtocolMigrationPlan = { move: [], keep: [], unmovable: [] };
  for (const protocol of protocols) {
    if (protocol.source?.authoredBy !== "agent") { plan.keep.push(protocol.name); continue; }
    const to = procedureName(protocol.name);
    if (to.length < 2) plan.unmovable.push({ name: protocol.name, reason: "name cannot become a procedure name" });
    else if (!bodyOf(protocol)) plan.unmovable.push({ name: protocol.name, reason: "no body, steps, or rules" });
    else plan.move.push({ from: protocol.name, to });
  }
  return plan;
}

/** Default capability evidence: every tool the session's own chat turns
 *  called, from the durable op store. Empty when those ops were pruned. */
async function sessionToolEvidence(sessionId: string): Promise<string[]> {
  const { listOps, isInteractiveHostOpType } = await import("../ops/op-store.js");
  const { readOpTurns } = await import("../canonical-loop/index.js");
  const tools: string[] = [];
  for (const op of listOps()) {
    if (op.sessionId !== sessionId || !isInteractiveHostOpType(op.type) || op.parentOpId) continue;
    for (const turn of readOpTurns(op.id)) {
      for (const call of turn.toolCallSummary ?? []) tools.push(call.tool);
    }
  }
  return tools;
}

export async function migrateAgentAuthoredProtocols(
  options: AgentProtocolMigrationOptions = {},
): Promise<AgentProtocolMigrationReport> {
  const before = catalogReadFailureCount();
  const protocols = loadCustomProtocols();
  if (catalogReadFailureCount() !== before) {
    throw new Error("custom.json could not be read cleanly — refusing to rewrite it");
  }
  const plan = planAgentProtocolMigration(protocols);
  const report: AgentProtocolMigrationReport = { ...plan, backupPath: null, migrated: [] };
  if (plan.move.length === 0) return report;

  const now = options.now ?? Date.now();
  const source = customProtocolsPath();
  if (existsSync(source)) {
    report.backupPath = `${source}.pre-learned-migration-${now}.bak`;
    copyFileSync(source, report.backupPath);
  }

  const evidence = options.toolEvidenceForSession ?? sessionToolEvidence;
  const moved = new Set<string>();
  for (const { from, to } of plan.move) {
    const protocol = protocols.find((entry) => entry.name === from)!;
    const sessionId = protocol.source?.authoredFromSession || MIGRATED_SESSION;
    const result = proposeReviewedProcedure({
      name: to,
      description: protocol.description,
      triggers: protocol.triggers ?? [],
      body: bodyOf(protocol),
      outcome: "unverified",
      sessionId,
      toolSequence: sessionId === MIGRATED_SESSION ? [] : await evidence(sessionId),
      timestamp: protocol.source?.authoredAt ?? now,
    });
    if (!result.ok) {
      report.unmovable.push({ name: from, reason: result.message });
      continue;
    }
    moved.add(from);
    report.migrated.push({ from, to, candidateId: result.candidateId });
  }
  if (moved.size > 0) saveCustomProtocols(protocols.filter((entry) => !moved.has(entry.name)));
  return report;
}
