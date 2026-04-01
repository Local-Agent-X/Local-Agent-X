import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "./types.js";
import { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { checkSessionPolicy } from "./session-policy.js";
import { ariEvaluate, isAriActive } from "./ari-kernel.js";
import { recordSensitiveRead, checkEgressTaint, isSensitivePath } from "./data-lineage.js";
import { compactIfNeeded } from "./context-manager.js";

// ── OpenAI tool format conversion ──

export function toolsToOpenAI(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ── Context compaction helper ──

export function checkAndCompact(
  messages: ChatCompletionMessageParam[],
  model: string,
  onEvent?: (event: ServerEvent) => void,
  force: boolean = false
): ChatCompletionMessageParam[] {
  const result = compactIfNeeded(messages, model, force);

  onEvent?.({
    type: "context_status",
    percentage: result.status.percentage,
    level: result.status.level,
    usedTokens: result.status.usedTokens,
    maxTokens: result.status.maxTokens,
    compacted: result.compacted,
  });

  return result.messages;
}

// ── Approval context ──

export function getRiskLevel(_toolName: string, _args: Record<string, unknown>, _security?: SecurityLayer): "low" | "medium" | "high" {
  return "low";
}

export function buildApprovalContext(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return `Run command: "${String(args.command || "").slice(0, 150)}"`;
    case "write":
      return `Create file: ${String(args.path || "").split(/[/\\]/).pop()} (${String(args.content || "").length} chars)`;
    case "edit":
      return `Edit file: ${String(args.path || "").split(/[/\\]/).pop()}`;
    case "read":
      return `Read file: ${String(args.path || "").split(/[/\\]/).pop()}`;
    case "browser": {
      const a = String(args.action || "");
      if (a === "navigate" || a === "new_tab") return `Open website: ${args.url || ""}`;
      if (a === "evaluate") return `Run script in browser: ${String(args.script || "").slice(0, 80)}`;
      return `Browser: ${a}`;
    }
    case "http_request":
      return `API call: ${args.method || "GET"} ${String(args.url || "").slice(0, 100)}`;
    case "web_fetch":
      return `Fetch webpage: ${String(args.url || "").slice(0, 100)}`;
    case "build_app":
      return `Build app: ${String(args.name || "")}`;
    default:
      return `${toolName}: ${JSON.stringify(args).slice(0, 80)}`;
  }
}

// ── Security-layered tool execution ──

export async function executeToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  toolMap: Map<string, ToolDefinition>,
  security: SecurityLayer,
  toolPolicy?: ToolPolicy,
  threatEngine?: ThreatEngine,
  rbac?: RBACManager,
  callerRole?: Role,
  sessionId?: string,
  onEvent?: (event: ServerEvent) => void,
  signal?: AbortSignal
): Promise<ChatCompletionMessageParam[]> {
  const results: ChatCompletionMessageParam[] = [];

  for (const tc of toolCalls) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.arguments);
    } catch (parseErr) {
      console.warn(`[agent] Malformed JSON in tool call arguments for ${tc.name}: ${(parseErr as Error).message}`);
      args = { _raw: tc.arguments };
    }

    // Build rich approval context for risky tool calls
    const riskLevel = getRiskLevel(tc.name, args, security);
    const approvalContext = buildApprovalContext(tc.name, args);
    const requiresApproval = riskLevel === "high";
    onEvent?.({ type: "tool_start", toolName: tc.name, args, riskLevel, context: approvalContext, requiresApproval });

    // Layer -1: AriKernel (taint tracking, behavioral rules, quarantine)
    const isInternalTool = tc.name.startsWith("agent_") || tc.name.startsWith("swarm_") ||
      tc.name.startsWith("mission_") || tc.name.startsWith("cron_") ||
      ["delegate", "generate_image", "generate_video", "camera_capture", "screen_capture", "ocr",
       "memory_search", "memory_save", "playbook_list", "playbook_get"].includes(tc.name);
    if (isAriActive()) {
      const actionMap: Record<string, string> = { read: "read", write: "write", edit: "write", bash: "exec" };
      const ariResult = await ariEvaluate(tc.name, actionMap[tc.name] || "exec", args);
      if (!ariResult.allowed) {
        if (isInternalTool) {
          console.warn(`[ari] Internal tool ${tc.name} flagged but allowed: ${ariResult.reason}`);
        } else {
          const result = ariResult.reason;
          onEvent?.({ type: "tool_end", toolName: tc.name, result, allowed: false });
          results.push({ role: "tool", tool_call_id: tc.id, content: result } as any);
          continue;
        }
      }
    }

    // Layer 0: Session policy (per-session overrides — high-security, read-only, etc.)
    const policyBlock = checkSessionPolicy(sessionId || "default", tc.name);
    if (policyBlock) {
      onEvent?.({ type: "tool_end", toolName: tc.name, result: policyBlock, allowed: false });
      results.push({ role: "tool", tool_call_id: tc.id, content: policyBlock } as any);
      continue;
    }

    // Layer 1: SecurityLayer (SSRF, shell, file access, path traversal)
    const secDecision = security.evaluate({
      toolName: tc.name,
      args,
      sessionId: sessionId || "default",
    });

    // Layer 2: RBAC tool permission
    let rbacBlocked = false;
    let rbacReason = "";
    if (rbac && callerRole) {
      const rbacDecision = rbac.checkTool(callerRole, tc.name);
      if (!rbacDecision.allowed) {
        rbacBlocked = true;
        rbacReason = rbacDecision.reason;
      }
    }

    // Layer 3: ToolPolicy (configurable allow/deny rules, rate limits, host constraints)
    let policyBlocked = false;
    let policyReason = "";
    if (secDecision.allowed && !rbacBlocked && toolPolicy) {
      const policyDecision = toolPolicy.evaluate(tc.name, args, sessionId || "default");
      if (!policyDecision.allowed) {
        policyBlocked = true;
        policyReason = policyDecision.reason;
      }
    }

    const allowed = secDecision.allowed && !rbacBlocked && !policyBlocked;
    let result: ToolResult;

    if (!secDecision.allowed) {
      result = { content: `BLOCKED by security: ${secDecision.reason}`, isError: true };
    } else if (rbacBlocked) {
      result = { content: `BLOCKED by RBAC: ${rbacReason}`, isError: true };
    } else if (policyBlocked) {
      result = { content: `BLOCKED by policy: ${policyReason}`, isError: true };
    } else {
      // Data lineage: block egress if session has tainted data
      const egressTools = ["http_request", "web_fetch"];
      if (egressTools.includes(tc.name)) {
        const egressCheck = checkEgressTaint(sessionId || "default");
        if (egressCheck.blocked) {
          result = { content: `BLOCKED by data lineage: ${egressCheck.reason}`, isError: true };
          onEvent?.({ type: "tool_end", toolName: tc.name, result: result.content, allowed: false });
          results.push({ role: "tool", tool_call_id: tc.id, content: result.content } as any);
          continue;
        }
      }

      const tool = toolMap.get(tc.name);
      if (!tool) {
        result = { content: `Unknown tool: ${tc.name}`, isError: true };
      } else {
        try {
          result = await tool.execute(args, signal);
          // Data lineage: record sensitive reads for taint tracking
          if (tc.name === "read" && isSensitivePath(String(args.path || ""))) {
            recordSensitiveRead(sessionId || "default", "sensitive_file", String(args.path));
          }
        } catch (e) {
          result = { content: `Tool error: ${(e as Error).message}`, isError: true };
        }
      }
    }

    // Layer 4: ThreatEngine post-execution analysis
    if (threatEngine) {
      const threat = threatEngine.evaluateToolResult(tc.name, args, result.content, allowed);
      if (threat.blocked) {
        result = { content: `BLOCKED by threat engine: ${threat.reason}`, isError: true };
      }
      if (threatEngine.isRestricted() && ["http_request", "web_fetch", "browser"].includes(tc.name)) {
        let isOwnApp = false;
        if (tc.name === "browser") {
          const urlArg = String(args.url || "");
          const appPort = process.env.SAX_PORT || "7007";
          if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${appPort}`, "i").test(urlArg)) {
            isOwnApp = true;
          } else if (!urlArg) {
            try {
              const { getBrowserManager } = await import("./browser.js");
              isOwnApp = getBrowserManager(sessionId || "default").isOnOwnApp();
            } catch {}
          }
        }
        if (!isOwnApp) {
          result = {
            content: `BLOCKED: Session threat level is ${threat.threatLevel} (score: ${threat.threatScore}). External tool calls are restricted. Resolve security concerns first.`,
            isError: true,
          };
        }
      }
    }

    onEvent?.({
      type: "tool_end",
      toolName: tc.name,
      result: result.content,
      allowed,
    });

    // Check if tool returned an image for vision analysis
    const imageData = (result as any)._image;
    if (imageData) {
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `Image loaded: ${imageData.path}\nQuestion: ${imageData.question}`,
      });
      results.push({
        role: "user",
        content: [
          { type: "text", text: `[Image from ${imageData.path}] ${imageData.question}` },
          { type: "image_url", image_url: { url: `data:${imageData.mime};base64,${imageData.b64}`, detail: "auto" } },
        ],
      } as any);
    } else {
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content,
      });
    }
  }

  return results;
}
