import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AgentOptions } from "../providers/types.js";
import { runAgentViaCanonical } from "../canonical-loop/agent-runner.js";
import { extractAgentOutput, safeErrorMessage } from "../server-utils.js";
import { EventBus } from "../event-bus.js";
import { ProjectStore, type AgentRun } from "../agent-store/index.js";
import { looksLikeClarificationRequest, looksLikeUnsubstantiatedCompletion, looksLikeEmptyOrErrorOnly } from "../agents/result-guard.js";
import { registerAgentRunDriver, type AgentRunDriver } from "../agents/runtime.js";
import { Handler } from "../agency/handler.js";
import type { LAXConfig, Session, ToolDefinition } from "../types.js";
import type { SessionStore, MemoryIndex } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { AgentRunStore, AgentTemplateStore } from "../agent-store/index.js";

import { createLogger } from "../logger.js";
import { clearSessionProfile } from "../autonomy/profile-store.js";
import { setSessionWorkRoot, clearSessionWorkRoot } from "../workspace/paths.js";
const logger = createLogger("server.handler-events");

interface AgentSpawnEvent { agentId: string; name: string; role: string; task: string; systemPrompt?: string; parentAgentId?: string; parentSessionId?: string; templateId?: string | null }
interface AgentOutputEvent { agentId: string; output: string }
interface AgentBlockedEvent { agentId: string; reason: string; role: string }
interface AgentResultEvent { agentId: string; result: string; success: boolean; tokens?: number }
interface AgentRedirectEvent { agentId: string; [key: string]: unknown }
interface AgentEscalationEvent {
  from: string;
  fromName: string;
  to: string;
  toName?: string;
  context: string;
  urgency: "normal" | "high";
  issueId?: string;
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
  agentRunStore: AgentRunStore;
  agentTemplateStore: AgentTemplateStore;
  broadcastAll: (event: Record<string, unknown>) => void;
}): void {
  const {
    config, dataDir, sessions, sessionStore, memoryIndex, secretsStore, security, toolPolicy,
    allAgentTools, agentRunStore, agentTemplateStore, broadcastAll,
  } = deps;

  const eventBus = EventBus.getInstance();
  const pendingMeta = new Map<string, { name: string; role: string; task: string; systemPrompt: string; parentAgentId: string | null; sessionId: string; startedAt: number; toolsUsed: string[]; templateId: string | null }>();

  // Canonical-loop driver — registered with agents/runtime so invokeAgent
  // dispatches here. Returns the terminal outcome; invokeDefinition fans
  // it out to subscribers (chunk-runner, AgentRunStore persistence, UI
  // broadcast) via handler:agent-result / -done / -error.
  const agentRunDriver: AgentRunDriver = async (req, signal) => {
    const { agentId, task, systemPrompt, role, parentSessionId, templateId, tools: invocationTools, modelOverride } = req;
    logger.info(`[handler] Agent ${agentId} (${role}) starting: ${task.slice(0, 80)}...`);
    const runSessionId = req.sessionId ?? `agent-${agentId}`;

    const template = templateId ? agentTemplateStore.get(templateId) : null;
    const projectStore = ProjectStore.getInstance();
    const agentProject = template ? projectStore.getAgentProject(template.id) : null;
    // Hierarchy (reportsTo) lives in the project roster post-L3.
    const { ProjectRosterStore } = await import("../project-rosters.js");
    const roster = template && agentProject ? ProjectRosterStore.getInstance().get(agentProject.id, template.id) : undefined;

    let parentContext = "";
    if (parentSessionId) { const ps = sessions.get(parentSessionId); if (ps?.messages.length) { parentContext = `\n\n--- PARENT CONTEXT ---\n${ps.messages.slice(-10).filter(m => typeof m.content === "string").map(m => `${m.role === "user" ? "User" : "Agent"}: ${(m.content as string).slice(0, 200)}`).join("\n")}\n--- END ---\n`; } }
    // Briefing assembly (USER.md + recent facts + task-relevant memory +
    // project brief + secrets) lives in agents/briefing.ts. agentProject is
    // resolved above and now actually fed in, and the task keys a semantic
    // memory search — both gaps the old inline block had.
    let briefing = "";
    try {
      const { buildBriefing } = await import("../agents/briefing.js");
      briefing = await buildBriefing({
        dataDir, memoryIndex, secretsStore, task,
        project: agentProject ? { id: agentProject.id, name: agentProject.name } : null,
      });
    } catch (e) {
      logger.warn(`[handler] briefing assembly failed for ${agentId}: ${(e as Error).message}`);
    }

    const identityBlock = template
      ? `\n\n--- YOUR IDENTITY ---\nAgent ID: ${template.id}\nName: ${template.name}\nRole: ${template.role}\n${roster?.reportsTo ? `Reports to: ${roster.reportsTo}` : "Reports to: Board (user)"}\n${agentProject ? `Project: ${agentProject.name}` : ""}\nUse agent_whoami with agentId="${template.id}" to see your full status and assigned issues.\n--- END IDENTITY ---\n`
      : `\n\nYour agent ID: ${agentId}\n`;

    const agentSession: Session = { id: `agent-${agentId}`, title: `Agent: ${role}`, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    let worktreeInfo: { path: string; branch: string } | null = null;
    let workRootRegistered = false;
    try {
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
      const { resolveToolsForRequest } = await import("../tool-search.js");
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

      // Worktree decision is now explicit per AgentDefinition. Legacy
      // role-string regex (`isCodeRole`) deleted per AUDIT Cluster 11.
      // Default false = run in main workspace; true = isolated LAX-repo
      // worktree for src/ edits only.
      const requiresWorktree = template?.requiresWorktree ?? false;
      let worktreeBlock = "";
      if (requiresWorktree) {
        try {
          const { createWorktree } = await import("../agency/worktree.js");
          worktreeInfo = createWorktree(agentId);
          if (worktreeInfo) {
            security.addAllowedPath(worktreeInfo.path, `agent-${agentId}`);
            worktreeBlock = `\n\n--- WORKTREE ---\nYou are in an isolated git worktree at: ${worktreeInfo.path}\nCode changes: cd here first. Output files (reports, exports) go to ${resolve(config.workspace)}/ (worktree gets cleaned up).\n--- END WORKTREE ---\n`;
          }
        } catch { /* not a git repo */ }
      } else if (req.workRoot) {
        // Project worker: the generic WORKSPACE block below points at the
        // data root and taught workers to read spec/plan.md THERE (live
        // failure 2026-07-02: four reads of <data root>/spec/plan.md
        // tripped the read circuit breaker). One root, stated once.
        const workRootFwd = req.workRoot.replace(/\\/g, "/");
        worktreeBlock = `\n\n--- PROJECT ROOT ---\nAll your work happens under: ${workRootFwd}\nRelative paths in file tools resolve against it. For bash, cd "${workRootFwd}" first. Do not read or write anywhere else.\n--- END PROJECT ROOT ---\n`;
      } else {
        worktreeBlock = `\n\n--- WORKSPACE ---\nWrite files (screenshots, exports, notes) to ${resolve(config.workspace)}/. You have bash/write/edit for non-code tasks. Do NOT edit the repo's source code.\n--- END WORKSPACE ---\n`;
      }

      // Project work-root provisioning: callers whose workers mutate a
      // project that is NOT the LAX repo (auto-build chunk workers) pass
      // req.workRoot. Registering it gives the run the same standing a
      // worktree grants — the delegated-bash gate keys on session
      // allowed-paths — and anchors the session's RELATIVE file paths to
      // the project (write("app/x.tsx") lands in the project, not the
      // data root). Scoped to this run, removed in the finally. Keyed by
      // runSessionId — the id the tools' _sessionId and the gate's
      // ctx.sessionId both carry.
      if (!worktreeInfo && req.workRoot) {
        security.addAllowedPath(req.workRoot, runSessionId);
        setSessionWorkRoot(runSessionId, req.workRoot);
        workRootRegistered = true;
      }

      logger.info(`[handler] Agent ${agentId} using ${provider}/${model} with ${spawnedTools.length} tools${worktreeInfo ? ` (worktree: ${worktreeInfo.path})` : req.workRoot ? ` (work root: ${req.workRoot})` : " (no worktree)"}`);
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
      const executionRules =
        `\n\nEXECUTION RULES:\n` +
        `- Platform: ${platformLine}\n` +
        `- You have ~${Math.max(40, config.maxIterations)} tool calls max. Each should do real work.\n` +
        `- After every tool call, briefly check the result matched expectations. If not, change approach — don't repeat the same call.\n` +
        `- If a tool fails twice with the same args, switch tools or arguments.\n` +
        `- Browser work: navigate → snapshot → click/fill by ref. Use new_tab + switch_tab for multi-site goals. Never start at sso./auth./login. subdomains — go to the main domain.\n` +
        `- Login safety: if Sign In doesn't advance on FIRST try, pause — don't retry (lockouts). Never read or output password field values.\n` +
        `- Forms: emit multiple fill calls in one turn, then snapshot once. Don't re-observe between independent field fills.\n` +
        (requiresWorktree ? `- Save results to workspace/ as you go. For large files use python -c one-liners, not read.\n` : `- Save exports/screenshots/notes to workspace/. Don't edit repo source.\n`);
      // Wall-clock ceiling threaded into canonical via wallClockMs — the
      // runner issues opCancel on expiry so the state machine transitions
      // running → cancelling → cancelled cleanly. Replaces the caller-side
      // setTimeout + AbortController pair the legacy path used (which
      // aborted via signal — out-of-band from the loop). The
      // invokeDefinition-supplied AbortSignal also routes through canonical
      // via this options.signal, so Handler.cancelAgent → opCancel works.
      const agentResult = await runAgentViaCanonical(task, agentSession.messages, {
        apiKey, model, provider: provider as AgentOptions["provider"], systemPrompt: (systemPrompt || `You are a ${role} agent. Complete the task. STOP if login is needed or after 3 failed attempts. End with a summary.`) + executionRules + identityBlock + parentContext + briefing + worktreeBlock,
        tools: spawnedTools, security, toolPolicy, sessionId: runSessionId, maxIterations: config.maxIterations, temperature: config.temperature,
        wallClockMs: config.agentTimeoutMs,
        opType: "agent_spawn",
        lane: "agent",
        runId: agentId,
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
            // buildStatus reports live progress. output[] stays empty during a
            // canonical run, so this is the only thing that actually moves.
            try { Handler.getInstance().noteAgentActivity(agentId); } catch {}
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
        security.removeAllowedPath(worktreeInfo.path, `agent-${agentId}`);
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
            return { result: `[Agent finished with no usable output (${empty.reason}) and committed no work]${agentOutput ? `\n\n${agentOutput}` : ""}`, success: false };
          }
        }
        // False-completion guard: the driver has both the output text AND the
        // AgentTurn's committedWork ledger signal. Default TRUE so any path
        // that didn't populate the signal can never false-positive.
        const completion = looksLikeUnsubstantiatedCompletion(agentOutput, agentResult.committedWork ?? true);
        if (completion.isUnsubstantiated) {
          logger.warn(`[handler] Agent ${agentId} (${role}) claimed committing action ("${completion.matchedPhrase}") with no successful committing tool call — re-classified as error`);
          return { result: `[Agent claimed a committing action ("${completion.matchedPhrase}") but made no successful committing tool call — likely a false completion]\n\n${agentOutput}`, success: false };
        }
        return { result: agentOutput, success: true };
      }
      const branchHint = worktreeInfo ? `Changes preserved on branch agent/${agentId}. Run: git merge agent/${agentId}` : "File changes may be lost";
      return { result: `[Agent completed but merge had conflicts — ${branchHint}]\n\n${agentOutput}`, success: false };
    } catch (e) {
      if (worktreeInfo) security.removeAllowedPath(worktreeInfo.path, `agent-${agentId}`);
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
      if (workRootRegistered && req.workRoot) {
        security.removeAllowedPath(req.workRoot, runSessionId);
        clearSessionWorkRoot(runSessionId);
      }
      // Tear down any inherited per-session profile override (set at spawn in
      // invoke.ts). Only for the auto-minted per-run session — an explicit
      // req.sessionId is a shared/borrowed session whose lifecycle the caller owns.
      if (!req.sessionId) clearSessionProfile(runSessionId);
    }
  };
  registerAgentRunDriver(agentRunDriver);

  eventBus.on("handler:agent-spawn", (d: unknown) => { const evt = d as AgentSpawnEvent; broadcastAll({ type: "agent-spawn", ...evt }); pendingMeta.set(evt.agentId, { name: evt.name, role: evt.role, task: evt.task, systemPrompt: evt.systemPrompt || "", parentAgentId: evt.parentAgentId || null, sessionId: evt.parentSessionId || "", startedAt: Date.now(), toolsUsed: [], templateId: evt.templateId || null }); });
  eventBus.on("handler:agent-output", (d: unknown) => { broadcastAll({ type: "agent-output", ...(d as AgentOutputEvent) }); });
  eventBus.on("handler:agent-blocked", (d: unknown) => { const evt = d as AgentBlockedEvent; broadcastAll({ type: "agent-blocked", agentId: evt.agentId, reason: evt.reason, role: evt.role }); });
  eventBus.on("handler:agent-result", (d: unknown) => {
    const evt = d as AgentResultEvent;
    broadcastAll({ type: "agent-complete", ...evt });
    const m = pendingMeta.get(evt.agentId);
    if (m) {
      // Result-shape guard: catch agents that finished by asking the
      // user to resend the task instead of doing it. Without this, a
      // 300-char clarification request quietly persists as status:
      // "done" and inflates the success rate in History. See
      // src/agents/result-guard.ts for the heuristic and rationale.
      const explicitFailure = evt.success === false;
      let guardError: string | undefined;
      if (!explicitFailure && typeof evt.result === "string") {
        const verdict = looksLikeClarificationRequest(evt.result);
        if (verdict.isClarificationRequest) {
          guardError = `Agent bailed without completing the task (clarification-request shape: "${verdict.matchedPhrase}"). Spawned agents do NOT have a conversation channel — they must complete or report a structured blocker.`;
          logger.warn(`[handler] Agent ${evt.agentId} (${m.role}) bailed with clarification request — re-classified as error`);
        }
      }
      const status: AgentRun["status"] = explicitFailure || guardError ? "failed" : "succeeded";
      const errorField = explicitFailure ? evt.result : guardError;
      agentRunStore.save({ id: evt.agentId, parentAgentId: m.parentAgentId, sessionId: m.sessionId, name: m.name, role: m.role, task: m.task, systemPrompt: m.systemPrompt, status, output: [], result: evt.result || "", toolsUsed: m.toolsUsed, tokensUsed: evt.tokens || 0, startedAt: m.startedAt, completedAt: Date.now(), error: errorField, templateId: m.templateId || undefined } as AgentRun);
      if (m.sessionId && evt.result) {
        try {
          const parentSession = sessionStore.load(m.sessionId);
          if (parentSession) {
            const label = evt.success === false ? `Agent ${m.name} failed` : `Agent ${m.name} completed`;
            parentSession.messages.push({ role: "assistant", content: `**${label}:**\n\n${evt.result}` } as any);
            parentSession.updatedAt = Date.now();
            sessionStore.save(parentSession);
          }
        } catch {}
      }
      pendingMeta.delete(evt.agentId);
    }
  });
  eventBus.on("handler:agent-redirect", (d: unknown) => { const evt = d as AgentRedirectEvent; broadcastAll({ type: "agent-update", ...evt, status: "redirected" }); });
  // agent_escalate emits this when its `to` resolves to "user" (or
  // record-only to another agent). Forward to the chat-attached UI; the
  // renderer treats wakeUser=true as a higher-priority alert. UI styling
  // is a follow-up chunk — the channel + payload ship now.
  eventBus.on("handler:agent-escalation", (d: unknown) => {
    const evt = d as AgentEscalationEvent;
    broadcastAll({
      type: "agent-escalation",
      from: evt.from,
      fromName: evt.fromName,
      to: evt.to,
      toName: evt.toName,
      context: evt.context,
      urgency: evt.urgency,
      issueId: evt.issueId,
      wakeUser: evt.to === "user" && evt.urgency === "high",
    });
  });
}
