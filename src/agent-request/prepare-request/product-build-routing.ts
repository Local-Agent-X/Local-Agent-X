import type { ToolDefinition } from "../../types.js";
import type { IntentVerdict } from "../../classifiers/intent-classifier.js";
import {
  resolveAppBuildContinuation,
  type AppBuildContinuationResolution,
} from "../../auto-build/workflow-resolver.js";

export const BUILD_ROUTE_QUESTION =
  "Is this a Quick Build (prototype/demo) or a Product Build (planned, production-ready app)?";

export type ProductBuildAction =
  | "build_app"
  | "start_app_build"
  | "run_build_plan"
  | "build_plan_status"
  | "build_plan_resume"
  | "conversation";

export interface ProductBuildTurn {
  kind: "quick" | "product" | "clarify" | "continuation" | "ambiguous";
  action: ProductBuildAction | null;
  targetTool?: Exclude<ProductBuildAction, "conversation">;
  projectDir?: string;
  reason: string;
  directive: string;
}

export type ContinuationResolver = (sessionId: string) => AppBuildContinuationResolution;

const CONTINUATION_ACTION_RE = /\b(?:continue|resume|restart|pick\s+(?:it|this|that|the\s+build)\s+up|keep\s+(?:building|going)|status|progress)\b/i;
const BUILD_OBJECT_RE = /\b(?:app|build|product|project|orchestrat(?:or|ion))\b/i;
const BUILD_STATUS_RE = /\b(?:how(?:'s|\s+is)|what(?:'s|\s+is))\s+(?:the\s+|my\s+|that\s+)?(?:app|build|product|project)\b/i;
const NEW_BUILD_RE = /\b(?:another|new|different|separate)\s+(?:app|build|product|project)\b/i;

export function isProductBuildContinuationRequest(message: string): boolean {
  if (NEW_BUILD_RE.test(message)) return false;
  return BUILD_OBJECT_RE.test(message)
    && (CONTINUATION_ACTION_RE.test(message) || BUILD_STATUS_RE.test(message));
}

function projectArg(projectDir: string | undefined): string {
  return projectDir ? ` with project_dir="${projectDir.replace(/\\/g, "/")}"` : "";
}

function continuationTurn(resolution: AppBuildContinuationResolution): ProductBuildTurn | null {
  if (resolution.kind === "none") return null;
  if (resolution.kind === "ambiguous") {
    const projects = resolution.candidates
      .map(candidate => candidate.projectDir)
      .filter((value): value is string => Boolean(value))
      .map(value => value.replace(/\\/g, "/"));
    const question = projects.length > 0
      ? `Which Product Build project do you want to continue: ${projects.join(" or ")}?`
      : "Which Product Build project do you want to continue?";
    return {
      kind: "ambiguous",
      action: null,
      reason: "Multiple durable Product Build candidates matched this continuation request.",
      directive: `Do not call a build tool and do not guess. Ask exactly one question: ${question}`,
    };
  }

  const { candidate, action } = resolution;
  if (action === "conversation") {
    const instruction = candidate.phase === "planning"
      ? "Continue the existing spec-first planning conversation."
      : candidate.phase === "complete"
        ? "Tell the user the Product Build is complete and discuss next steps."
        : "Explain the current Product Build state and continue the conversation.";
    return {
      kind: "continuation",
      action,
      projectDir: candidate.projectDir,
      reason: candidate.reason,
      directive:
        `Product Build continuation resolved to action=conversation${projectArg(candidate.projectDir)}. ` +
        `Reason: ${candidate.reason} ${instruction} Do not call build_app or build inline.`,
    };
  }

  return {
    kind: "continuation",
    action,
    targetTool: action,
    projectDir: candidate.projectDir,
    reason: candidate.reason,
    directive:
      `Product Build continuation resolved to action=${action}${projectArg(candidate.projectDir)}. ` +
      `Reason: ${candidate.reason} Call ${action}${projectArg(candidate.projectDir)} now. ` +
      "Do not call build_app and do not build the app inline.",
  };
}

export function resolveProductBuildContinuationTurn(
  message: string,
  sessionId: string,
  resolver: ContinuationResolver = resolveAppBuildContinuation,
): ProductBuildTurn | null {
  if (!isProductBuildContinuationRequest(message)) return null;
  return continuationTurn(resolver(sessionId));
}

export function productBuildTurnFromIntent(verdict: IntentVerdict | null): ProductBuildTurn | null {
  if (verdict?.kind !== "build_app") return null;
  const reason = verdict.reason || "The request was classified as a new app build.";
  if (verdict.buildRoute === "quick") {
    return {
      kind: "quick",
      action: "build_app",
      targetTool: "build_app",
      reason,
      directive:
        `Build routing selected action=build_app (Quick Build). Reason: ${reason} ` +
        "Call build_app now. The background builder owns the entire build; do not build it inline.",
    };
  }
  if (verdict.buildRoute === "product") {
    return {
      kind: "product",
      action: "start_app_build",
      targetTool: "start_app_build",
      reason,
      directive:
        `Build routing selected action=start_app_build (Product Build), project_dir=not-created. Reason: ${reason} ` +
        "Call start_app_build now with the user's concept. It owns spec-first planning; do not call build_app or build inline.",
    };
  }
  return {
    kind: "clarify",
    action: null,
    reason,
    directive: `Do not call a build tool and do not build inline. Ask exactly this and nothing else: ${BUILD_ROUTE_QUESTION}`,
  };
}

const BUILD_WORKFLOW_TOOLS = new Set([
  "build_app",
  "start_app_build",
  "finalize_app_build",
  "run_build_plan",
  "build_plan_status",
  "build_plan_resume",
]);

export function applyProductBuildToolRoute(
  tools: ToolDefinition[],
  allTools: ToolDefinition[],
  turn: ProductBuildTurn | null,
): ToolDefinition[] {
  if (!turn) return tools;
  const kept = tools.filter(tool => !BUILD_WORKFLOW_TOOLS.has(tool.name));
  if (!turn.targetTool) return kept;
  const target = allTools.find(tool => tool.name === turn.targetTool);
  return target ? [target, ...kept] : kept;
}
