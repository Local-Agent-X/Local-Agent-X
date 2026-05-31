/**
 * Generic self_edit surgeon runner — wires the in-loop surgeon at startup.
 *
 * The surgeon registry (src/self-edit/generic-surgeon.ts) owns dispatch; this
 * is the one place the server's config / secrets / tools / toolPolicy are
 * available, so the runner is registered here (mirrors
 * registerWorkerRunnerForServer). It drives LAX's OWN agent loop
 * (runAgentViaCanonical) scoped to the self_edit worktree, on the active
 * provider — the last-resort surgeon for providers with no coding CLI.
 *
 * Keeping the loop call behind this registration boundary means self-edit/*
 * never imports the canonical loop directly.
 */
import { type AgentOptions } from "../../providers/types.js";
import { runAgentViaCanonical } from "../../canonical-loop/agent-runner.js";
import { extractAgentOutput } from "../../server-utils.js";
import { SecurityLayer } from "../../security/index.js";
import type { LAXConfig, ToolDefinition } from "../../types.js";
import type { SecretsStore } from "../../secrets.js";
import type { ToolPolicy } from "../../tool-policy.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("server.background-jobs.self-edit-surgeon");

export interface SelfEditSurgeonRunnerDeps {
  config: LAXConfig;
  dataDir: string;
  secretsStore: SecretsStore;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
}

const SURGEON_TOOLS = ["read", "write", "edit", "bash", "glob", "grep"];

function surgeonPersona(worktreePath: string): string {
  return [
    "You are the self_edit surgeon for Local Agent X (LAX). You are editing LAX's OWN TypeScript source,",
    `checked out in an isolated git worktree at: ${worktreePath}`,
    "Make ONLY the change described in the user's message. Read the relevant files first, then edit in place.",
    "You may edit any file in the worktree, including normally-protected ones. Do NOT run installs or git commands —",
    "the sandbox handles dependency install, build, boot, and merge after you finish.",
    "When the change is complete, stop and briefly summarize what you changed (files + one line each).",
    "Keep the diff minimal and match the surrounding code's style.",
  ].join(" ");
}

export function registerSelfEditSurgeonForServer(deps: SelfEditSurgeonRunnerDeps): void {
  const { config, dataDir, secretsStore, toolPolicy, allAgentTools } = deps;
  import("../../self-edit/generic-surgeon.js").then(({ registerGenericSurgeon }) => {
    registerGenericSurgeon(async (worktreePath, message) => {
      const { resolveProvider } = await import("../../agent-request/index.js");
      const { provider, apiKey, model } = await resolveProvider(config, secretsStore, dataDir);
      // Writes are confined to the worktree — the surgeon edits LAX source there,
      // and the sandbox gates + merge pick it up. The worktree branch is the
      // only thing that ships, so a botched edit fails the gates, never merges.
      const sessionId = `selfedit-surgeon-${(worktreePath.split(/[\\/]/).pop() || "wt")}`;
      const security = new SecurityLayer(worktreePath, "common");
      security.addAllowedPath(worktreePath, sessionId);
      const tools = allAgentTools.filter(t => SURGEON_TOOLS.includes(t.name));
      const result = await runAgentViaCanonical(message, [], {
        apiKey, model,
        provider: provider as AgentOptions["provider"],
        systemPrompt: surgeonPersona(worktreePath),
        tools, security, toolPolicy, sessionId,
        maxIterations: 30,
        opType: "self_edit",
        lane: "background",
      });
      return extractAgentOutput(result.messages);
    });
    logger.info("[self-edit] generic surgeon runner registered");
  }).catch((e) => logger.warn(`[self-edit] surgeon runner registration failed: ${(e as Error).message}`));
}
