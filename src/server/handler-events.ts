import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent, type AgentOptions } from "../agent.js";
import { extractAgentOutput, safeErrorMessage } from "../server-utils.js";
import { enqueue } from "../execution-lanes.js";
import { EventBus } from "../event-bus.js";
import { ProjectStore, type AgentRun } from "../agent-store.js";
import { looksLikeClarificationRequest } from "../agents/result-guard.js";
import type { LAXConfig, Session, ToolDefinition } from "../types.js";
import type { SessionStore } from "../memory.js";
import type { SecretsStore } from "../secrets.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { AgentRunStore, AgentTemplateStore } from "../agent-store.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.handler-events");

interface AgentRunEvent { agentId: string; task: string; systemPrompt: string; role: string; parentSessionId?: string; templateId?: string }
interface AgentSpawnEvent { agentId: string; name: string; role: string; task: string; systemPrompt?: string; parentAgentId?: string; parentSessionId?: string }
interface AgentOutputEvent { agentId: string; output: string }
interface AgentBlockedEvent { agentId: string; reason: string; role: string }
interface AgentResultEvent { agentId: string; result: string; success: boolean; tokens?: number }
interface AgentUserInputEvent { agentId: string; message: string }
interface AgentRedirectEvent { agentId: string; [key: string]: unknown }

export function registerHandlerEvents(deps: {
  config: LAXConfig;
  dataDir: string;
  sessions: Map<string, Session>;
  sessionStore: SessionStore;
  secretsStore: SecretsStore;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
  agentRunStore: AgentRunStore;
  agentTemplateStore: AgentTemplateStore;
  broadcastAll: (event: Record<string, unknown>) => void;
}): void {
  const {
    config, dataDir, sessions, sessionStore, secretsStore, security, toolPolicy,
    allAgentTools, agentRunStore, agentTemplateStore, broadcastAll,
  } = deps;

  const eventBus = EventBus.getInstance();
  const pendingMeta = new Map<string, { name: string; role: string; task: string; systemPrompt: string; parentAgentId: string | null; sessionId: string; startedAt: number; toolsUsed: string[] }>();

  eventBus.on("handler:agent-run", async (data: unknown) => {
    const { agentId, task, systemPrompt, role, parentSessionId } = data as AgentRunEvent;
    const templateId = (data as AgentRunEvent).templateId;
    logger.info(`[handler] Agent ${agentId} (${role}) starting: ${task.slice(0, 80)}...`);

    const template = templateId ? agentTemplateStore.get(templateId) : null;
    const projectStore = ProjectStore.getInstance();
    const agentProject = template ? projectStore.getAgentProject(template.id) : null;
    // Hierarchy (reportsTo) lives in the project roster post-L3.
    const { ProjectRosterStore } = await import("../project-rosters.js");
    const roster = template && agentProject ? ProjectRosterStore.getInstance().get(agentProject.id, template.id) : undefined;

    let parentContext = "";
    if (parentSessionId) { const ps = sessions.get(parentSessionId); if (ps?.messages.length) { parentContext = `\n\n--- PARENT CONTEXT ---\n${ps.messages.slice(-10).filter(m => typeof m.content === "string").map(m => `${m.role === "user" ? "User" : "Agent"}: ${(m.content as string).slice(0, 200)}`).join("\n")}\n--- END ---\n`; } }
    let briefing = "";
    try { const uMd = join(dataDir, "memory", "USER.md"), mMd = join(dataDir, "memory", "MIND.md"); const u = existsSync(uMd) ? readFileSync(uMd, "utf-8").slice(0, 500) : "", m = existsSync(mMd) ? readFileSync(mMd, "utf-8").slice(0, 500) : ""; briefing = `\n\n--- BRIEFING ---\nUser: ${u || "(none)"}\nFacts: ${m || "(none)"}\nSecrets: ${secretsStore.list().map(s => s.name).join(", ") || "(none)"}\n--- END ---\n`; } catch {}

    const identityBlock = template
      ? `\n\n--- YOUR IDENTITY ---\nAgent ID: ${template.id}\nName: ${template.name}\nRole: ${template.role}\n${roster?.reportsTo ? `Reports to: ${roster.reportsTo}` : "Reports to: Board (user)"}\n${agentProject ? `Project: ${agentProject.name}` : ""}\nUse agent_whoami with agentId="${template.id}" to see your full status and assigned issues.\n--- END IDENTITY ---\n`
      : `\n\nYour agent ID: ${agentId}\n`;

    const agentSession: Session = { id: `agent-${agentId}`, title: `Agent: ${role}`, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    let worktreeInfo: { path: string; branch: string } | null = null;
    try {
      const { resolveProvider } = await import("../agent-request.js");
      const { provider, apiKey, model } = await resolveProvider(config, secretsStore, dataDir);

      // Canonical resolver: read each tool's `audiences` field. Spawned
      // agents default to the "spawned-agent" audience; ops-phase workers
      // (role === "operator") use the narrower "operator" audience.
      // Per-template restrictions apply via templateAllowedTools, with
      // identity helpers always preserved (see resolveToolsForRequest).
      const { resolveToolsForRequest } = await import("../tool-search.js");
      const audience = role === "operator" ? "operator" : "spawned-agent";
      const spawnedTools = resolveToolsForRequest(
        {
          audience,
          templateAllowedTools: template?.allowedTools && template.allowedTools.length > 0
            ? template.allowedTools
            : undefined,
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
      } else {
        worktreeBlock = `\n\n--- WORKSPACE ---\nWrite files (screenshots, exports, notes) to ${resolve(config.workspace)}/. You have bash/write/edit for non-code tasks. Do NOT edit the repo's source code.\n--- END WORKSPACE ---\n`;
      }

      logger.info(`[handler] Agent ${agentId} using ${provider}/${model} with ${spawnedTools.length} tools${worktreeInfo ? ` (worktree: ${worktreeInfo.path})` : " (no worktree)"}`);
      const platformLine = process.platform === "win32"
        ? "Windows. bash runs PowerShell — use PowerShell syntax (Get-ChildItem, Select-Object) and Windows paths."
        : "Linux/macOS. bash runs /bin/bash.";
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
      const ac = new AbortController(); const to = setTimeout(() => { ac.abort(); logger.warn(`[handler] Agent ${agentId} timed out`); }, config.agentTimeoutMs);
      const agentResult = await enqueue("agent", () => runAgent(task, agentSession.messages, {
        apiKey, model, provider: provider as AgentOptions["provider"], systemPrompt: (systemPrompt || `You are a ${role} agent. Complete the task. STOP if login is needed or after 3 failed attempts. End with a summary.`) + executionRules + identityBlock + parentContext + briefing + worktreeBlock,
        tools: spawnedTools, security, toolPolicy, sessionId: `agent-${agentId}`, maxIterations: config.maxIterations, temperature: config.temperature, signal: ac.signal,
        pauseCallback: async (reason: string) => { eventBus.emit("handler:agent-output", { agentId, output: `[BLOCKER] ${reason}` }); eventBus.emit("handler:agent-blocked", { agentId, reason, role }); return new Promise<string>(r => { const h = (d: unknown) => { const evt = d as AgentUserInputEvent; if (evt.agentId === agentId) { eventBus.off("handler:agent-user-input", h); r(evt.message); } }; eventBus.on("handler:agent-user-input", h); setTimeout(() => { eventBus.off("handler:agent-user-input", h); r("User did not respond."); }, config.agentTimeoutMs); }); },
        onEvent: (event) => { if (event.type === "stream" && event.delta) eventBus.emit("handler:agent-output", { agentId, output: event.delta }); if (event.type === "tool_start") { logger.info(`[handler] Agent ${agentId} tool: ${event.toolName}`); eventBus.emit("handler:agent-output", { agentId, output: `[tool] ${event.toolName}...` }); } if (event.type === "tool_progress") { eventBus.emit("handler:agent-output", { agentId, output: `[progress] ${event.message}` }); } if (event.type === "tool_start" && event.requiresApproval) event.requiresApproval = false; },
      }), { label: `agent:${agentId}`, timeout: config.agentTimeoutMs });
      clearTimeout(to); if (agentResult?.messages) agentSession.messages.push(...agentResult.messages);

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
        eventBus.emit("handler:agent-result", { agentId, result: agentOutput, success: true });
      } else {
        const branchHint = worktreeInfo ? `Changes preserved on branch agent/${agentId}. Run: git merge agent/${agentId}` : "File changes may be lost";
        eventBus.emit("handler:agent-result", { agentId, result: `[Agent completed but merge had conflicts — ${branchHint}]\n\n${agentOutput}`, success: false });
      }
    } catch (e) {
      if (worktreeInfo) security.removeAllowedPath(worktreeInfo.path, `agent-${agentId}`);
      try { const { cleanupWorktree } = await import("../agency/worktree.js"); cleanupWorktree(agentId); } catch {}
      const p = extractAgentOutput(agentSession.messages), msg = (e as Error).name === "AbortError" ? "Agent timed out" : safeErrorMessage(e); eventBus.emit("handler:agent-result", { agentId, result: p ? `[${msg}]\n\n${p}` : msg, success: false });
    }
  });

  eventBus.on("handler:agent-spawn", (d: unknown) => { const evt = d as AgentSpawnEvent; broadcastAll({ type: "agent-spawn", ...evt }); pendingMeta.set(evt.agentId, { name: evt.name, role: evt.role, task: evt.task, systemPrompt: evt.systemPrompt || "", parentAgentId: evt.parentAgentId || null, sessionId: evt.parentSessionId || "", startedAt: Date.now(), toolsUsed: [] }); });
  eventBus.on("handler:agent-output", (d: unknown) => { const evt = d as AgentOutputEvent; broadcastAll({ type: "agent-output", ...evt }); const m = pendingMeta.get(evt.agentId); if (m && typeof evt.output === "string" && evt.output.startsWith("[tool]")) { const t = evt.output.replace("[tool] ", "").replace("...", "").trim(); if (t && !m.toolsUsed.includes(t)) m.toolsUsed.push(t); } });
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
      const status: AgentRun["status"] = explicitFailure || guardError ? "error" : "done";
      const errorField = explicitFailure ? evt.result : guardError;
      agentRunStore.save({ id: evt.agentId, parentAgentId: m.parentAgentId, sessionId: m.sessionId, name: m.name, role: m.role, task: m.task, systemPrompt: m.systemPrompt, status, output: [], result: evt.result || "", toolsUsed: m.toolsUsed, tokensUsed: evt.tokens || 0, startedAt: m.startedAt, completedAt: Date.now(), error: errorField } as AgentRun);
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
}
