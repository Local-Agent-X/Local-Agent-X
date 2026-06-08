import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AgentOptions } from "../../providers/types.js";
import { runAgentViaCanonical } from "../../canonical-loop/agent-runner.js";
import { stripEphemeralMessages } from "../../providers/sanitize.js";
import { extractAgentOutput } from "../../server-utils.js";
import { SecurityLayer } from "../../security/index.js";
import type { LAXConfig, Session, ToolDefinition } from "../../types.js";
import type { MemoryIndex, MemoryManager } from "../../memory/index.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy.js";
import type { CronService } from "../../cron/cron-service.js";
import type { IntegrationRegistry } from "../../integrations/index.js";
import { validateMissionOutput } from "../../cron/output-validation.js";
import { createLogger } from "../../logger.js";
import { CRON_SYSTEM_PROMPT } from "./prompts.js";
import { setSessionProfile, clearSessionProfile } from "../../autonomy/profile-store.js";

const logger = createLogger("server.background-jobs.cron");

// 20-min default — thorough multi-source research (web_search + 3-5
// web_fetch hits) routinely runs 10-15min just on TLS + page-load time,
// leaving no headroom for the final synthesis. Old 10min default tripped
// wall-clock aborts mid-research, dropping the agent into the "no final
// assistant message" path → extractAgentOutput fell back to dumping
// raw tool results → off-topic detector flagged → report failed.
const MISSION_HARD_TIMEOUT_MS = Number(process.env.LAX_MISSION_TIMEOUT_MS) || 20 * 60_000;
// Buffer reserved at the END of the mission window for the post-wait
// synthesis (build the report, write to disk, classify, return).
const POST_SUB_AGENT_BUFFER_MS = 60_000;
// Floor on how long we'll wait, even when budget is tight.
const SUB_AGENT_WAIT_MIN_MS = 30_000;
const SUB_AGENT_WAIT_HARD_CAP_MS = Number(process.env.LAX_SUB_AGENT_WAIT_MS) || 0;

const stripCronPreamble = (p: string): string => {
  const patterns = [
    /^every day at \d{1,2}(:\d{2})?\s*(am|pm)?,?\s*/i,
    /^every day,?\s*/i,
    /^daily at \d{1,2}(:\d{2})?\s*(am|pm)?,?\s*/i,
    /^daily,?\s*/i,
    /^at \d{1,2}(:\d{2})?\s*(am|pm)?\s+(every day|daily),?\s*/i,
    /^each (day|morning|evening|night),?\s*/i,
  ];
  let out = p.trim();
  for (const re of patterns) out = out.replace(re, "");
  return out.trim();
};

const stripSaveInstructions = (p: string): string => {
  const patterns = [
    /[,.\s]*\b(?:and\s+)?save\s+(?:the|this|your)?\s*(?:output|report|results?|file)?\s*(?:to|in|at|as)\s+\S*\.md\b[^.]*\.?/gi,
    /[,.\s]*\bsave\s+(?:to|in|at)\s+workspace\/\S+/gi,
    /[,.\s]*\bwrite\s+(?:the|this|your)?\s*(?:output|report|results?|file)?\s*(?:to|in|at)\s+\S*\.md\b[^.]*\.?/gi,
    /[,.\s]*\boutput\s+(?:to|in|at)\s+workspace\/\S+/gi,
  ];
  let out = p;
  for (const re of patterns) out = out.replace(re, "");
  return out.trim();
};

export interface CronRunnerDeps {
  config: LAXConfig;
  dataDir: string;
  memoryIndex: MemoryIndex;
  memoryManager: MemoryManager;
  secretsStore: SecretsStore;
  toolPolicy: ToolPolicy;
  cronService: CronService;
  integrations: IntegrationRegistry;
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  cronReportsDir: string;
  getOrCreateSession: (id: string) => Session;
  saveSession: (s: Session) => Promise<void>;
}

export function registerCronRunner(deps: CronRunnerDeps): void {
  const {
    config, dataDir, memoryIndex, memoryManager, secretsStore, toolPolicy,
    cronService, integrations, allAgentTools, bridgeTools, cronReportsDir,
    getOrCreateSession, saveSession,
  } = deps;

  cronService.onExecute(async (jobId, prompt, _ctx) => {
    const missionStartMs = Date.now();
    // Confine scheduled jobs to the SAME workspace the rest of the app uses
    // (config.workspace — the single source of truth, which tracks a Settings
    // workspace move), at the tightest "workspace only" mode since cron runs
    // unattended. Previously this read LAX_WORKSPACE ?? ~/.lax/workspace, so a
    // user who moved their workspace had cron jobs pointed at the wrong folder.
    const cronSecurity = new SecurityLayer(config.workspace, "workspace");
    const sessionId = `cron-${jobId}-${Date.now()}`;
    const cleanedPrompt = stripSaveInstructions(stripCronPreamble(prompt));
    const jobMeta = cronService.get(jobId);
    const { prepareAgentRequest } = await import("../../agent-request/index.js");
    const prepared = await prepareAgentRequest({
      channel: "cron", message: cleanedPrompt, sessionMessages: [], sessionId,
      config, dataDir, memoryIndex, memoryManager, integrations, secretsStore,
      allAgentTools, bridgeTools, skipMemory: true,
      providerOverride: jobMeta?.provider || undefined,
      modelOverride: jobMeta?.model || undefined,
    });
    // Anthropic-pin fallback: cron defaults to sonnet-4-6 instead of opus
    // for cost reasons. Only fires when the user hasn't explicitly chosen
    // a model for this job.
    const cronModel = jobMeta?.model
      ? prepared.model
      : (prepared.provider === "anthropic" ? "claude-sonnet-4-6" : prepared.model);
    const providerName = String(prepared.provider);
    const wrappedPrompt = `<scheduled_task>\n${cleanedPrompt}\n</scheduled_task>`;
    // no recursive scheduling, no file writes — agent's returned text IS the report
    const cronTools = prepared.tools.filter(t => !t.name.startsWith("mission_schedule_") && t.name !== "write" && t.name !== "edit");
    const externalCancelController = new AbortController();
    cronService.registerRunAbort(jobId, externalCancelController);
    // Pin this run's tool-approval decisions to the job's profile (if set).
    // Without it, ask-tier tools the job needs (network-write, comms, money)
    // block unattended under the global profile. Cleared in finally so the
    // override never outlives the run.
    if (jobMeta?.profile) setSessionProfile(sessionId, jobMeta.profile);
    let result;
    try {
      result = await runAgentViaCanonical(wrappedPrompt, [], {
        apiKey: prepared.apiKey,
        model: cronModel,
        provider: prepared.provider as AgentOptions["provider"],
        systemPrompt: CRON_SYSTEM_PROMPT,
        tools: cronTools,
        security: cronSecurity,
        toolPolicy,
        sessionId,
        maxIterations: config.maxIterations,
        signal: externalCancelController.signal,
        wallClockMs: MISSION_HARD_TIMEOUT_MS,
        opType: "scheduled_mission",
        lane: "background",
      });
    } finally {
      cronService.unregisterRunAbort(jobId);
      clearSessionProfile(sessionId);
    }
    const session = getOrCreateSession(sessionId);
    session.messages = stripEphemeralMessages(result.messages).filter(m => m.role !== "system"); session.updatedAt = Date.now(); saveSession(session);
    let output = extractAgentOutput(result.messages);
    const spawnNameRe = /^(agent_spawn|delegate)$/;
    const hasSpawn = result.messages.some(m => {
      if (m.role !== "assistant" || !Array.isArray(m.content)) return false;
      return (m.content as Array<{ type?: string; name?: string }>).some(b => b?.type === "tool_use" && typeof b.name === "string" && spawnNameRe.test(b.name));
    });
    if (hasSpawn) {
      try {
        const { Handler } = await import("../../agency/handler.js");
        const handler = Handler.getInstance();
        const subWaitStart = Date.now();
        // Budget-aware wait. Sub-agents have until the mission's overall
        // budget runs out (minus the synthesis buffer), not an arbitrary
        // 5min ceiling.
        const elapsed = subWaitStart - missionStartMs;
        const remaining = MISSION_HARD_TIMEOUT_MS - elapsed - POST_SUB_AGENT_BUFFER_MS;
        let waitMs = Math.max(SUB_AGENT_WAIT_MIN_MS, remaining);
        if (SUB_AGENT_WAIT_HARD_CAP_MS > 0) waitMs = Math.min(waitMs, SUB_AGENT_WAIT_HARD_CAP_MS);
        logger.info(`[cron] Job ${jobId}: waiting up to ${(waitMs/1000).toFixed(0)}s for ${1}+ sub-agent(s) to finish (mission elapsed ${(elapsed/1000).toFixed(0)}s of ${(MISSION_HARD_TIMEOUT_MS/1000).toFixed(0)}s budget)`);
        const subResults = await handler.waitForSessionAgents(sessionId, waitMs);
        const subWaitMs = Date.now() - subWaitStart;
        if (subResults.length > 0) {
          const subOutput = subResults.join("\n\n---\n\n");
          output = subOutput.length > output.length ? subOutput : output + "\n\n---\n\n" + subOutput;
          logger.info(`[cron] Job ${jobId}: collected ${subResults.length} sub-agent result(s) in ${subWaitMs}ms`);
        } else if (subWaitMs >= waitMs - 500) {
          logger.warn(`[cron] Job ${jobId}: sub-agent wait timed out after ${subWaitMs}ms (budget exhausted) — any in-flight sub-agent output is dropped`);
        }
      } catch (e) { logger.warn(`[cron] Sub-agent wait error:`, (e as Error).message); }
    }
    if (!output) {
      logger.error(`[cron] Job ${jobId} produced no output (stopReason: ${result.stopReason})`);
      return {
        output: "ERROR: Agent produced no output — check provider/model config",
        status: "error",
        errorMessage: `no output (stopReason: ${result.stopReason})`,
        provider: providerName, model: cronModel,
      };
    }
    const trimmed = output.trim();
    const stopReason = result.stopReason || "unknown";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jobDir = join(cronReportsDir, jobId);
    if (!existsSync(jobDir)) mkdirSync(jobDir, { recursive: true });
    const job = cronService.get(jobId);
    const validation = validateMissionOutput(cleanedPrompt, trimmed, stopReason);
    // Salvage rule (mirrors src/ops/worker-entry.ts classifyOpResult):
    // judge by evidence — if the agent produced substantive content that
    // passes refusal/topic/length/truncation checks, ship it to canonical
    // even when the terminal stopReason is "error".
    if (!validation.valid && !validation.contentValid) {
      const reason = validation.reason!;
      const failedDir = join(jobDir, "failed");
      if (!existsSync(failedDir)) mkdirSync(failedDir, { recursive: true });
      const failedPath = join(failedDir, `${ts}.md`);
      const failedContent = `# FAILED — ${job?.name || jobId} — ${new Date().toLocaleString()}\n\nReason: ${reason}\nstopReason: ${stopReason}\n\n## Prompt\n\n\`\`\`\n${cleanedPrompt}\n\`\`\`\n\n## Raw agent output\n\n\`\`\`\n${trimmed}\n\`\`\`\n`;
      writeFileSync(failedPath, failedContent, "utf-8");
      try { appendFileSync(join(cronReportsDir, "_failures.log"), `${new Date().toISOString()}\t${job?.name || ""}\t${jobId}\tstop=${stopReason}\t${reason}\n`, "utf-8"); } catch {}
      logger.error(`[cron] Job ${jobId} (${job?.name || "?"}) FAILED quality gate — ${reason}; postmortem at ${failedPath}; canonical report NOT written`);
      return {
        output: `FAILED: ${reason}`,
        status: "failed",
        errorMessage: reason,
        provider: providerName, model: cronModel,
      };
    }
    const salvaged = !validation.valid && validation.contentValid;
    const reportPath = join(jobDir, `${ts}.md`);
    const salvageBanner = salvaged ? `\n\n> Note: terminal stopReason was \`${stopReason}\` — content checks passed, salvaged to canonical.\n` : "";
    const reportContent = `# ${job?.name || jobId} — ${new Date().toLocaleDateString()}${salvageBanner}\n\n${output}`;
    // Wrap the canonical report write so a disk error surfaces as a real
    // run failure instead of being silently swallowed.
    try {
      writeFileSync(reportPath, reportContent, "utf-8");
    } catch (e) {
      const msg = `disk-write failed: ${(e as Error).message}`;
      logger.error(`[cron] Job ${jobId} report save to ${reportPath} FAILED: ${msg}`);
      return {
        output: `ERROR: report write failed — ${msg}`,
        status: "error",
        errorMessage: msg,
        provider: providerName, model: cronModel,
      };
    }
    const slug = (job?.name || jobId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    const missionDir = join(resolve(config.workspace), "missions", slug);
    // workspace/missions mirror write is best-effort — canonical report at
    // reportPath above is the source of truth.
    try {
      mkdirSync(missionDir, { recursive: true });
      writeFileSync(join(missionDir, "latest.md"), reportContent, "utf-8");
    } catch (e) {
      logger.warn(`[cron] Job ${jobId} workspace mirror write to ${missionDir} failed (canonical at ${reportPath} OK): ${(e as Error).message}`);
    }
    if (salvaged) {
      try { appendFileSync(join(cronReportsDir, "_failures.log"), `${new Date().toISOString()}\t${job?.name || ""}\t${jobId}\tstop=${stopReason}\tSALVAGED ${trimmed.length} chars to canonical\n`, "utf-8"); } catch {}
      logger.warn(`[cron] Job ${jobId} (${job?.name || "?"}) salvaged: stopReason=${stopReason} but ${trimmed.length} chars passed content checks — saved to ${reportPath}`);
    } else {
      logger.info(`[cron] Report saved: ${reportPath}`);
    }
    return {
      output: output.slice(0, 500), reportPath,
      status: "success",
      provider: providerName, model: cronModel,
    };
  });
}
