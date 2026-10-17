import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type AgentOptions } from "../providers/types.js";
import { runAgentViaCanonical } from "../canonical-loop/index.js";
import { extractAgentOutput, safeErrorMessage } from "../server-utils.js";
import { targetPinForModelOverride } from "../agent-request/target-pin.js";
import { EventBus } from "../event-bus.js";
import { ProjectStore } from "../agent-store/index.js";
import { looksLikeUnsubstantiatedCompletion, looksLikeEmptyOrErrorOnly } from "../agents/result-guard.js";
import { registerAgentRunDriver, type AgentRunDriver } from "../agents/runtime.js";
import { Handler } from "../agency/handler.js";
import { registerAgentLifecycleEvents, type PendingAgentMeta } from "./handler-events-agent-result.js";
import type { GlobalFrame } from "../chat-ws/frames.js";
import type { LAXConfig, Session, ToolDefinition } from "../types.js";
import type { SessionStore, MemoryIndex } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { AgentRunStore, AgentTemplateStore } from "../agent-store/index.js";
import type { IntegrationRegistry } from "../integrations/index.js";
import { createLogger } from "../logger.js";
import { clearSessionProfile } from "../autonomy/profile-store.js";
import { registerChildSessionOwner, clearSessionOwner } from "../browser/session-owner-registry.js";
import { AgentWorkspaceError, provisionAgentWorkspace, releaseAgentWorkspace, type AgentWorkspace } from "../agency/agent-workspace.js";
import { requiredPromptPlan } from "../context/system-prompt-builder.js";
import { OP_TYPE } from "../ops/op-types.js";
const logger = createLogger("server.handler-events");

// AgentSpawnEvent / AgentResultEvent live in handler-events-agent-result.ts
// with the listeners that consume them.

// Worker execution rules appended to every spawned agent's system prompt.
// Exported (pure) so tests can assert the composed invariants. The final-
// report rule keeps the supervisor-side delegation promise: the parent
// surfaces only a ~180-char preview of the result (ops/pending-notifications
// SUMMARY_PREVIEW_CHARS), so the outcome must lead, not trail.
export function buildExecutionRules(platformLine: string, maxIterations: number, requiresWorktree: boolean): string {
  return (
    `\n\nEXECUTION RULES:\n` +
    `- Platform: ${platformLine}\n` +
    `- You have ~${Math.max(40, maxIterations)} tool calls max. Each should do real work.\n` +
    `- After every tool call, briefly check the result matched expectations. If not, change approach — don't repeat the same call.\n` +
    `- If a tool fails twice with the same args, switch tools or arguments.\n` +
    `- Browser work: navigate → snapshot → click/fill by ref. Use new_tab + switch_tab for multi-site goals. Never start at sso./auth./login. subdomains — go to the main domain.\n` +
    `- Login safety: if Sign In doesn't advance on FIRST try, pause — don't retry (lockouts). Never read or output password field values.\n` +
    `- Forms: emit multiple fill calls in one turn, then snapshot once. Don't re-observe between independent field fills.\n` +
    (requiresWorktree ? `- Save results to workspace/ as you go. For large files use python -c one-liners, not read.\n` : `- Save exports/screenshots/notes to workspace/. Don't edit repo source.\n`) +
    `- Final report: lead with the concrete outcome — what you did or found, and where — in the first sentence. Your parent surfaces only a short preview of your report, so a buried result reads as no result. Details and evidence after.\n`
  );
}

export function registerHandlerEvents(deps: {
  config: LAXConfig;
  dataDir: string;
  sessions: Map<string, Session>;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
  integrations: IntegrationRegistry;
  agentRunStore: AgentRunStore;
  agentTemplateStore: AgentTemplateStore;
  broadcastAll: (frame: GlobalFrame) => void;
}): void {
  const {
    config, dataDir, sessions, sessionStore, memoryIndex, secretsStore, security, toolPolicy,
    allAgentTools, integrations, agentRunStore, agentTemplateStore, broadcastAll,
  } = deps;

  const eventBus = EventBus.getInstance();
  const pendingMeta = new Map<string, PendingAgentMeta>();

  // Canonical-loop driver — registered with agents/runtime so invokeAgent
  // dispatches here. Returns the terminal outcome; invokeDefinition fans
  // it out to subscribers (chunk-runner, AgentRunStore persistence, UI
  // broadcast) via handler:agent-result / -done / -error.
  const agentRunDriver: AgentRunDriver = async (req, signal) => {
    const { agentId, task, systemPrompt, role, parentSessionId, templateId, tools: invocationTools, modelOverride } = req;
    logger.info(`[handler] Agent ${agentId} (${role}) starting: ${task.slice(0, 80)}...`);
    const runSessionId = req.sessionId ?? `agent-${agentId}`;
    registerChildSessionOwner(runSessionId, parentSessionId, {
      agentId: templateId ?? agentId,
    });

    const template = templateId ? agentTemplateStore.get(templateId) : null;
    const projectStore = ProjectStore.getInstance();
    const agentProject = template ? projectStore.getAgentProject(template.id) : null;
    // Hierarchy (reportsTo) lives in the project roster post-L3.
    const { ProjectRosterStore } = await import("../project-rosters.js");
    const roster = template && agentProject ? ProjectRosterStore.getInstance().get(agentProject.id, template.id) : undefined;

    let parentContext = "";
    if (parentSessionId) { const ps = sessions.get(parentSessionId); if (ps?.messages.length) { parentContext = `\n\n--- PARENT CONTEXT ---\n${ps.messages.slice(-10).filter(m => typeof m.content === "string").map(m => `${m.role === "user" ? "User" : "Agent"}: ${(m.content as string).slice(0, 200)}`).join("\n")}\n--- END ---\n`; } }
    const identityBlock = template
      ? `\n\n--- YOUR IDENTITY ---\nAgent ID: ${template.id}\nName: ${template.name}\nRole: ${template.role}\n${roster?.reportsTo ? `Reports to: ${roster.reportsTo}` : "Reports to: Board (user)"}\n${agentProject ? `Project: ${agentProject.name}` : ""}\nUse agent_whoami with agentId="${template.id}" to see your full status and assigned issues.\n--- END IDENTITY ---\n`
      : `\n\nYour agent ID: ${agentId}\n`;

    const agentSession: Session = { id: `agent-${agentId}`, title: `Agent: ${role}`, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    // Where the run works, decided BEFORE it starts: a folder that can't be
    // isolated throws here, so the spawner hears why instead of getting an
    // agent whose every command is denied.
    const requiresWorktree = template?.requiresWorktree ?? false;
    let workspace: AgentWorkspace | null = null;
    try {
      workspace = provisionAgentWorkspace({
        agentId, runSessionId, security, requiresWorktree, workDir: req.workDir, workRoot: req.workRoot,
      });
      const { resolveProvider } = await import("../agent-request/index.js");
      // Thread the resolved per-agent model pin into the provider chain.
      // resolveAgentModel (invoke.ts) already walked run→roster→template;
      // the pin arrives here as req.modelOverride. When unset, we fall
      // through to the global default (no override args).
      const { provider, apiKey, model } = await resolveProvider(
        config,
        secretsStore,
        dataDir,
        modelOverride?.provider,
        modelOverride?.model,
      );

      // Canonical resolver: read each tool's `audiences` field. Spawned
      // agents default to the "spawned-agent" audience; ops-phase workers
      // (role === "operator") use the narrower "operator" audience.
      // Per-template restrictions apply via templateAllowedTools, with
      // identity helpers always preserved (see resolveToolsForRequest).
      // Falls back to the invocation's resolved tool list when no template
      // was provided (ad-hoc agents like operations/executor's phase agents
      // pass their tools through the invokeDefinition surface).
      const { resolveToolsForRequest } = await import("../tools/tool-search.js");
      const audience = role === "operator" ? "operator" : "spawned-agent";
      const spawnedTools = resolveToolsForRequest(
        {
          audience,
          templateAllowedTools: template?.allowedTools && template.allowedTools.length > 0
            ? template.allowedTools
            : (invocationTools && invocationTools.length > 0 ? invocationTools : undefined),
        },
        allAgentTools,
      );

      // Briefing assembly (USER.md + recent facts + task-relevant memory +
      // project brief + secrets + the integrations its tools reach) lives in
      // agents/briefing.ts. agentProject is resolved above and fed in, and the
      // task keys a semantic memory search — both gaps the old inline block had.
      let briefing = "";
      try {
        const { buildBriefing } = await import("../agents/briefing.js");
        briefing = await buildBriefing({
          dataDir, memoryIndex, secretsStore, task,
          project: agentProject ? { id: agentProject.id, name: agentProject.name } : null,
          integrations, toolNames: spawnedTools.map((t) => t.name),
        });
      } catch (e) {
        logger.warn(`[handler] briefing assembly failed for ${agentId}: ${(e as Error).message}`);
      }

      const worktreeInfo = workspace.worktree;
      logger.info(`[handler] Agent ${agentId} using ${provider}/${model} with ${spawnedTools.length} tools${worktreeInfo ? ` (worktree: ${worktreeInfo.path})` : workspace.workRoot ? ` (work root: ${workspace.workRoot})` : " (no worktree)"}`);
      // Describe the shell the bash tool will ACTUALLY run — the old
      // hardcoded "bash runs PowerShell" line predates Git Bash resolution
      // and taught workers the wrong syntax (backslash Windows paths in a
      // POSIX shell lose their separators: `cd C:\Users\...` → "C:Users...").
      let platformLine = "Linux/macOS. bash runs /bin/bash.";
      if (process.platform === "win32") {
        const { resolveWindowsShell } = await import("../tools/shell-env.js");
        platformLine = resolveWindowsShell().kind === "bash"
          ? "Windows with Git Bash. bash runs POSIX sh — use POSIX syntax, forward-slash paths (C:/Users/...), and quote any path containing spaces."
          : "Windows. bash runs PowerShell — use PowerShell syntax (Get-ChildItem, Select-Object) and Windows paths.";
      }
      const executionRules = buildExecutionRules(platformLine, config.maxIterations, !!(workspace.worktree || workspace.workRoot));
      // Wall-clock ceiling threaded into canonical via wallClockMs — the
      // runner issues opCancel on expiry so the state machine transitions
      // running → cancelling → cancelled cleanly. Replaces the caller-side
      // setTimeout + AbortController pair the legacy path used (which
      // aborted via signal — out-of-band from the loop). The
      // invokeDefinition-supplied AbortSignal also routes through canonical
      // via this options.signal, so Handler.cancelAgent → opCancel works.
      const agentSystemPrompt = (systemPrompt || `You are a ${role} agent. Complete the task. STOP if login is needed or after 3 failed attempts. End with a summary.`) + executionRules + identityBlock + parentContext + briefing + workspace.promptBlock;
      const agentResult = await runAgentViaCanonical(task, agentSession.messages, {
        apiKey, model, provider: provider as AgentOptions["provider"], systemPrompt: agentSystemPrompt,
        renderedPromptSections: requiredPromptPlan("spawned-agent", "Spawned Agent", agentSystemPrompt),
        tools: spawnedTools, security, toolPolicy, sessionId: runSessionId, maxIterations: config.maxIterations, temperature: config.temperature, targetPin: targetPinForModelOverride(modelOverride),
        callContext: "delegated",
        wallClockMs: config.agentTimeoutMs,
        opType: OP_TYPE.agentSpawn,
        lane: "agent",
        runId: agentId, harnessAuthoredTask: req.harnessAuthoredTask, delegation: req.delegation,
        signal,
        onEvent: (event) => {
          if (event.type === "stream" && "delta" in event && event.delta) {
            eventBus.emit("handler:agent-output", { agentId, output: event.delta });
          }
          if (event.type === "tool_start") {
            logger.info(`[handler] Agent ${agentId} tool: ${event.toolName}`);
            eventBus.emit("handler:agent-output", { agentId, output: `[tool] ${event.toolName}...` });
            const m = pendingMeta.get(agentId);
            if (m && !m.toolsUsed.includes(event.toolName)) m.toolsUsed.push(event.toolName);
            // Real-progress signal: bump the FieldAgent's tool-call counter so
            // buildStatus reports live progress, and record the tool on its
            // output log, which the cron status route reads as recentTools.
            try { Handler.getInstance().noteAgentActivity(agentId, event.toolName); } catch {}
            if (event.requiresApproval) event.requiresApproval = false;
          }
          if (event.type === "tool_progress") {
            eventBus.emit("handler:agent-output", { agentId, output: `[progress] ${event.message}` });
          }
          // Running per-op token total from a canonical turn_committed (relayed
          // by the agent-runner). Key it to this run's agentId and broadcast it
          // on the EXISTING agent-update channel — the client forwards the whole
          // payload to updateAgentFeed(agentId, msg), so msg.totalTokens lands
          // on the chunk-runner card's token bar with no client change. Additive:
          // other agent-update consumers ignore the extra field.
          if (event.type === "usage" && typeof event.totalTokens === "number") {
            broadcastAll({ type: "agent-update", agentId, totalTokens: event.totalTokens });
          }
        },
      });
      if (agentResult?.messages) agentSession.messages.push(...agentResult.messages);

      let mergeSuccess = true;
      if (worktreeInfo) {
        try {
          const { mergeWorktree } = await import("../agency/worktree.js");
          const mergeResult = mergeWorktree(agentId);
          const mergeMsg = mergeResult.merged
            ? (mergeResult.files > 0 ? `[Merged ${mergeResult.files} files back to main]` : "[No file changes]")
            : `[Merge failed: ${mergeResult.error}]`;
          eventBus.emit("handler:agent-output", { agentId, output: mergeMsg });
          if (!mergeResult.merged && mergeResult.files > 0) mergeSuccess = false;
        } catch (e) { logger.warn(`[worktree] Merge error: ${(e as Error).message}`); mergeSuccess = false; }
      }

      const agentOutput = extractAgentOutput(agentSession.messages);
      const opId = agentResult.opId;
      if (mergeSuccess) {
        // Empty-output guard: a run that committed no work AND produced no
        // usable text (or only a runner status marker) finished with nothing
        // to show. Gated on committedWork so a silent-but-effective run (wrote
        // a file, returned no prose) is never misflagged — the mutation is its
        // own receipt. Deterministic, no LLM reviewer.
        if (!(agentResult.committedWork ?? true)) {
          const empty = looksLikeEmptyOrErrorOnly(agentOutput);
          if (empty.isEmptyOrErrorOnly) {
            logger.warn(`[handler] Agent ${agentId} (${role}) finished with ${empty.reason} and no committed work — re-classified as error`);
            return { result: `[Agent finished with no usable output (${empty.reason}) and committed no work]${agentOutput ? `\n\n${agentOutput}` : ""}`, success: false, opId };
          }
        }
        // False-completion guard: the driver has both the output text AND the
        // AgentTurn's committedWork ledger signal. Default TRUE so any path
        // that didn't populate the signal can never false-positive.
        const completion = looksLikeUnsubstantiatedCompletion(agentOutput, agentResult.committedWork ?? true);
        if (completion.isUnsubstantiated) {
          logger.warn(`[handler] Agent ${agentId} (${role}) claimed committing action ("${completion.matchedPhrase}") with no successful committing tool call — re-classified as error`);
          return { result: `[Agent claimed a committing action ("${completion.matchedPhrase}") but made no successful committing tool call — likely a false completion]\n\n${agentOutput}`, success: false, opId };
        }
        return { result: agentOutput, success: true, opId };
      }
      const branchHint = worktreeInfo ? `Changes preserved on branch agent/${agentId}. Run: git merge agent/${agentId}` : "File changes may be lost";
      return { result: `[Agent completed but merge had conflicts — ${branchHint}]\n\n${agentOutput}`, success: false, opId };
    } catch (e) {
      // The folder the task named couldn't be isolated: say exactly why — the
      // path is the spawner's own input — so it can pick another.
      if (e instanceof AgentWorkspaceError) return { result: `Agent not started: ${e.message}`, success: false };
      const worktreeInfo = workspace?.worktree;
      try {
        const { commitInWorktree, cleanupWorktree } = await import("../agency/worktree.js");
        // Commit any in-flight edits onto the agent branch BEFORE teardown.
        // cleanupWorktree runs `git worktree remove --force`, which discards
        // the working tree — an agent cancelled mid-edit (e.g. a 20-min build
        // run that timed out) would otherwise lose everything, and the
        // "preserved" agent/<id> branch would point at base HEAD. Committing
        // first makes the preserved branch actually carry the WIP.
        if (worktreeInfo) {
          try { commitInWorktree(agentId, `Agent ${agentId}: work-in-progress (run aborted)`); }
          catch (ce) { logger.warn(`[worktree] Failed to preserve WIP for ${agentId}: ${(ce as Error).message}`); }
        }
        cleanupWorktree(agentId);
      } catch {}
      const p = extractAgentOutput(agentSession.messages);
      const msg = (e as Error).name === "AbortError" ? "Agent timed out" : safeErrorMessage(e);
      return { result: p ? `[${msg}]\n\n${p}` : msg, success: false };
    } finally {
      if (workspace) releaseAgentWorkspace(workspace, security, runSessionId);
      // Tear down any inherited per-session profile override (set at spawn in
      // invoke.ts). Only for the auto-minted per-run session — an explicit
      // req.sessionId is a shared/borrowed session whose lifecycle the caller owns.
      if (!req.sessionId) { clearSessionProfile(runSessionId); clearSessionOwner(runSessionId); }
    }
  };
  registerAgentRunDriver(agentRunDriver);

  // Spawn + result listeners (AgentRun persistence, parent-chat injection
  // for chat-initiated spawns only, agent-spawn/agent-complete broadcasts).
  registerAgentLifecycleEvents({ eventBus, pendingMeta, sessionStore, agentRunStore, broadcastAll });
  eventBus.on("handler:agent-output", (d) => { broadcastAll({ type: "agent-output", ...d }); });
  // The spread must not carry a `type` of its own over the frame's.
  eventBus.on("handler:agent-redirect", (d) => { broadcastAll({ ...d, type: "agent-update", status: "redirected" }); });
}
