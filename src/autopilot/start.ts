/**
 * startAutopilot — entry point for autopilot mode.
 *
 * Sequence:
 *   1. Validate request
 *   2. Resolve AutopilotConfig from request + per-repo autopilot.config.json
 *   3. Acquire per-repo lock (rejects if another autopilot is live)
 *   4. Create the named worktree + branch
 *   5. Construct Operation (manually — no phase decomposition)
 *   6. Kick off runAutopilotLoop in the background
 *   7. Return opId immediately so the caller doesn't block
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNamedWorktree } from "../agency/worktree.js";
import { acquireLock, registerExitCleanup } from "./lock.js";
import { runAutopilotLoop } from "./loop.js";
import type { AutopilotConfig, StartAutopilotRequest } from "./types.js";
import type { Operation } from "../operations/types.js";
import type { LAXConfig, ToolDefinition } from "../types.js";
import type { AgentOptions } from "../agent.js";
import { loadAnthropicTokens, isAnthropicTokenExpired } from "../auth-anthropic.js";

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.start");

/**
 * Pin autopilot rounds to Anthropic when available, regardless of who
 * launched the autopilot. Reason: Codex (gpt-5.x) has a fire-and-forget
 * disposition that produces narration-only rounds and trips the noop
 * detector. Sonnet/Opus actually use tools. We've validated this in
 * production — Codex autopilots hit max-noop-rounds, Anthropic autopilots
 * commit. Falls back to the launcher's provider only if Anthropic auth
 * is missing/expired.
 */
function pickAutopilotProvider(deps: StartAutopilotDeps): {
  provider: AgentOptions["provider"];
  apiKey: string;
  model: string;
  pinned: boolean;
} {
  if (deps.provider === "anthropic") {
    return { provider: deps.provider, apiKey: deps.apiKey, model: deps.model, pinned: false };
  }
  const tokens = loadAnthropicTokens();
  if (tokens && !isAnthropicTokenExpired(tokens)) {
    return {
      provider: "anthropic",
      // CLI sentinel — anthropic-cli adapter handles subscription auth.
      apiKey: "cli",
      // Sane default; user can override via autopilot.config.json later.
      model: "claude-sonnet-4-6",
      pinned: true,
    };
  }
  return { provider: deps.provider, apiKey: deps.apiKey, model: deps.model, pinned: false };
}

export interface StartAutopilotDeps {
  config: LAXConfig;
  apiKey: string;
  model: string;
  provider: AgentOptions["provider"];
  allTools: ToolDefinition[];
  /** Where Operation persistence lives. Same dir conductor uses. */
  workspaceDir: string;
}

export interface StartAutopilotResult {
  ok: true;
  opId: string;
  branchName: string;
  worktreePath: string;
  config: AutopilotConfig;
}

export interface StartAutopilotError {
  ok: false;
  reason: string;
  /** If blocked by lock, identifies the holder. */
  conflict?: { pid: number; opId: string; topic: string };
}

const DEFAULTS = {
  durationMs: 30 * 60_000,
  maxRounds: 20,
  maxNoopRounds: 2,
  maxSelfEditCalls: 5,
  withTests: false,
  buildCommand: "npm run build" as string | null,
  buildTimeoutMs: 300_000,
  testCommand: "npm test",
  testTimeoutMs: 600_000,
  fileSizeLimit: 400,
};

function loadRepoConfigOverrides(repoRoot: string): Partial<typeof DEFAULTS> {
  const cfgPath = join(repoRoot, ".lax", "autopilot.config.json");
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, "utf-8")) as Partial<typeof DEFAULTS>;
  } catch (e) {
    logger.warn(`[autopilot.start] autopilot.config.json invalid: ${(e as Error).message}`);
    return {};
  }
}

function slugify(topic: string): string {
  return topic.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "topic";
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "T").slice(0, 19);
}

function newOpId(): string {
  return "op_ap_" + Math.random().toString(36).slice(2, 10);
}

/** Look up the repo root we're running from. */
function getRepoRoot(): string {
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 5_000, windowsHide: true }).trim();
  } catch {
    return process.cwd();
  }
}

export async function startAutopilot(
  req: StartAutopilotRequest,
  deps: StartAutopilotDeps,
): Promise<StartAutopilotResult | StartAutopilotError> {
  // Validate request
  const topic = (req.topic || "").trim();
  if (!topic) return { ok: false, reason: "topic is required" };
  if (topic.length > 200) return { ok: false, reason: "topic too long (max 200 chars)" };
  const scope = (req.scope || []).map(s => s.trim()).filter(Boolean);
  if (scope.length === 0) return { ok: false, reason: "scope is required (at least one path/glob hint)" };

  // Resolve config
  const repoRoot = getRepoRoot();
  const overrides = loadRepoConfigOverrides(repoRoot);
  const slug = slugify(topic);
  const ts = nowSlug();
  const branchName = `autopilot/${slug}/${ts}`;
  const worktreeName = `autopilot-${slug}-${ts}`;

  const opId = newOpId();

  // Acquire lock BEFORE creating worktree so two starts don't race on git
  const blocked = acquireLock(opId, topic);
  if (blocked) {
    return {
      ok: false,
      reason: `Autopilot already running in this repo (pid=${blocked.pid}, op=${blocked.opId}, topic="${blocked.topic}")`,
      conflict: { pid: blocked.pid, opId: blocked.opId, topic: blocked.topic },
    };
  }
  registerExitCleanup(opId);

  // Create worktree
  const wt = createNamedWorktree(worktreeName, branchName);
  if (!wt) {
    // Release lock since we're not going to use it.
    const { releaseLock } = await import("./lock.js");
    releaseLock(opId);
    return { ok: false, reason: "Failed to create worktree (see server logs)" };
  }

  const autopilotConfig: AutopilotConfig = {
    topic,
    scope,
    durationMs: req.durationMs ?? overrides.durationMs ?? DEFAULTS.durationMs,
    maxRounds: req.maxRounds ?? overrides.maxRounds ?? DEFAULTS.maxRounds,
    maxNoopRounds: req.maxNoopRounds ?? overrides.maxNoopRounds ?? DEFAULTS.maxNoopRounds,
    maxSelfEditCalls: req.maxSelfEditCalls ?? overrides.maxSelfEditCalls ?? DEFAULTS.maxSelfEditCalls,
    withTests: req.withTests ?? overrides.withTests ?? DEFAULTS.withTests,
    worktreePath: wt.path,
    worktreeName,
    branchName: wt.branch,
    baseBranch: wt.baseBranch,
    buildCommand: overrides.buildCommand ?? DEFAULTS.buildCommand,
    buildTimeoutMs: overrides.buildTimeoutMs ?? DEFAULTS.buildTimeoutMs,
    testCommand: overrides.testCommand ?? DEFAULTS.testCommand,
    testTimeoutMs: overrides.testTimeoutMs ?? DEFAULTS.testTimeoutMs,
    fileSizeLimit: overrides.fileSizeLimit ?? DEFAULTS.fileSizeLimit,
  };

  // Construct Operation manually — bypass conductor.createOperation to skip
  // phase decomposition. Operation is just our persistence container here.
  const op: Operation = {
    id: opId,
    goal: topic,
    summary: `Autopilot: ${topic}`,
    phases: [],
    status: "running",
    createdAt: Date.now(),
    startedAt: Date.now(),
    currentPhase: 0,
    sharedState: {},
    events: [{ ts: Date.now(), level: "info", message: `Autopilot started — topic: "${topic}", branch: ${branchName}` }],
    autopilot: autopilotConfig,
    autopilotRounds: [],
  };

  const opDir = join(deps.workspaceDir, op.id);
  if (!existsSync(opDir)) mkdirSync(opDir, { recursive: true });
  writeFileSync(join(opDir, "operation.json"), JSON.stringify(op, null, 2), "utf-8");

  // Pin to Anthropic for round agents when possible — see pickAutopilotProvider
  // doc above for rationale (Codex narrates and bails; Anthropic commits).
  const picked = pickAutopilotProvider(deps);
  const effectiveDeps: StartAutopilotDeps = {
    ...deps,
    provider: picked.provider,
    apiKey: picked.apiKey,
    model: picked.model,
  };
  if (picked.pinned) {
    logger.info(`[autopilot.start] pinned round agents to anthropic (launcher was ${deps.provider}); model=${picked.model}`);
    op.events.push({
      ts: Date.now(),
      level: "info",
      message: `Round agents pinned to Anthropic (${picked.model}) for reliability — launcher was ${deps.provider}`,
    });
    writeFileSync(join(opDir, "operation.json"), JSON.stringify(op, null, 2), "utf-8");
  }

  // Kick off the loop in the background. Don't await — we return immediately.
  runAutopilotLoop(op, effectiveDeps).catch(e => {
    logger.error(`[autopilot.start] loop crashed for op ${opId}: ${(e as Error).message}`);
  });

  logger.info(`[autopilot.start] launched op ${opId} on ${branchName} (worktree ${wt.path}) provider=${picked.provider}`);

  return {
    ok: true,
    opId,
    branchName,
    worktreePath: wt.path,
    config: autopilotConfig,
  };
}
