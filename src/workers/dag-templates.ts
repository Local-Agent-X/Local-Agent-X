/**
 * DAG templates — named, reusable workflow shapes.
 *
 * Per spec §20: common patterns (research-then-build, audit-then-patch-
 * then-verify, design-then-implement) live as templates the supervisor
 * can match by intent OR the user can name explicitly.
 *
 * Each template is a function that takes a parameters object and returns
 * a DagSpec. Templates handle the boring bits (op id generation, default
 * retry policies, success criteria) so the caller just provides intent.
 */

import { newOpId } from "./op-store.js";
import { buildContextPack } from "./context-pack-builder.js";
import { getRetryPolicy } from "./heartbeat.js";
import type { DagSpec } from "./scheduler.js";
import type { Op, OpLane } from "./types.js";

// ── Template: research-then-build ─────────────────────────────────────────

/**
 * Op A researches a topic / inspects code; op B uses A's findings to build
 * something. B depends on A. Cancellation of A propagates to B.
 *
 * Use case: "look at our cron system and refactor any duplication" →
 * researchTask = "audit src/cron-service.ts and adjacent files for
 * duplication patterns"; buildTask = "apply the fixes from the research
 * report".
 */
export async function researchThenBuild(params: {
  researchTask: string;
  buildTask: string;
  scopeHint?: string;
  contextFiles?: string[];
  lane?: OpLane;
  preferredProvider?: string;
}): Promise<DagSpec> {
  const lane = params.lane ?? "build";
  const researchId = newOpId("op_research");
  const buildId = newOpId("op_build");

  const research: Op = {
    id: researchId,
    type: "research_query",
    task: params.researchTask,
    contextPack: await buildContextPack({
      description: params.researchTask,
      successCriteria: [
        "produce a structured findings document",
        "list specific files / locations / changes recommended",
        "do not modify any source files (read-only research)",
      ],
      constraints: ["read-only — do not edit, write, or commit anything"],
      referencedFilePaths: params.contextFiles,
      scopeForAgentsRules: params.scopeHint,
      lane,
      preferredProvider: params.preferredProvider,
    }),
    lane,
    retryPolicy: getRetryPolicy("research_query"),
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    outputContract: ["research_findings"],
  };

  const build: Op = {
    id: buildId,
    type: "build_app",
    task: params.buildTask,
    contextPack: await buildContextPack({
      description: params.buildTask,
      successCriteria: [
        "apply ONLY the changes the research op recommended",
        "build (npm run build) must pass",
        "do not invent new requirements beyond the research findings",
      ],
      constraints: ["base your work on the research op's findings; do not re-derive"],
      referencedFilePaths: params.contextFiles,
      scopeForAgentsRules: params.scopeHint,
      lane,
      preferredProvider: params.preferredProvider,
    }),
    lane,
    retryPolicy: getRetryPolicy("build_app"),
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    dependsOn: [researchId],
    inputBindings: { research_findings: researchId },
  };

  return { name: "research-then-build", ops: [research, build] };
}

// ── Template: audit-then-patch-then-verify ────────────────────────────────

/**
 * Three-step DAG: audit identifies issues, patch fixes them, verify runs
 * tests / builds to confirm. Patch depends on audit; verify depends on patch.
 *
 * Use case: "audit src/cron-service.ts for bugs, fix them, verify the
 * fix doesn't break the build."
 */
export async function auditThenPatchThenVerify(params: {
  auditTask: string;
  patchTask: string;
  verifyCommand?: string;     // default "npm run build"
  scopeHint?: string;
  contextFiles?: string[];
  lane?: OpLane;
  preferredProvider?: string;
}): Promise<DagSpec> {
  const lane = params.lane ?? "build";
  const verifyCmd = params.verifyCommand ?? "npm run build";
  const auditId = newOpId("op_audit");
  const patchId = newOpId("op_patch");
  const verifyId = newOpId("op_verify");

  const audit: Op = {
    id: auditId,
    type: "research_query",
    task: params.auditTask,
    contextPack: await buildContextPack({
      description: params.auditTask,
      successCriteria: ["produce a list of concrete bugs/issues", "include file:line for each"],
      constraints: ["read-only — do not edit"],
      referencedFilePaths: params.contextFiles,
      scopeForAgentsRules: params.scopeHint,
      lane, preferredProvider: params.preferredProvider,
    }),
    lane, retryPolicy: getRetryPolicy("research_query"),
    ownerId: "local-user", visibility: "private", status: "pending",
    createdAt: new Date().toISOString(), attemptCount: 0,
    outputContract: ["audit_findings"],
  };

  const patch: Op = {
    id: patchId,
    type: "self_edit",
    task: params.patchTask,
    contextPack: await buildContextPack({
      description: params.patchTask,
      successCriteria: ["apply ONLY fixes from the audit findings", "no scope creep"],
      constraints: ["base patches on the audit op's findings"],
      referencedFilePaths: params.contextFiles,
      scopeForAgentsRules: params.scopeHint,
      lane, preferredProvider: params.preferredProvider,
    }),
    lane, retryPolicy: getRetryPolicy("self_edit"),
    ownerId: "local-user", visibility: "private", status: "pending",
    createdAt: new Date().toISOString(), attemptCount: 0,
    dependsOn: [auditId],
    inputBindings: { audit_findings: auditId },
    outputContract: ["patch_summary"],
  };

  const verify: Op = {
    id: verifyId,
    type: "research_query",
    task: `Run \`${verifyCmd}\` and report whether it passes. If it fails, summarize the error.`,
    contextPack: await buildContextPack({
      description: `Run \`${verifyCmd}\` and report pass/fail.`,
      successCriteria: ["report exit code", "summarize first 50 lines of error if failed"],
      constraints: ["just run the verify command, don't try to fix"],
      lane, preferredProvider: params.preferredProvider,
    }),
    lane, retryPolicy: getRetryPolicy("research_query"),
    ownerId: "local-user", visibility: "private", status: "pending",
    createdAt: new Date().toISOString(), attemptCount: 0,
    dependsOn: [patchId],
    inputBindings: { patch_summary: patchId },
  };

  return { name: "audit-then-patch-then-verify", ops: [audit, patch, verify] };
}

// ── Template registry ─────────────────────────────────────────────────────

export const TEMPLATE_NAMES = ["research-then-build", "audit-then-patch-then-verify"] as const;
export type TemplateName = typeof TEMPLATE_NAMES[number];
