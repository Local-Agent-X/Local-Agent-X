import type { ToolDefinition, ToolResult } from "../../types.js";
import { withoutInternalArgs } from "../../tool-execution/internal-args.js";

/**
 * Collapse a family of `prefix_action` tools into ONE tool with an `action`
 * param. The inner ToolDefinitions stay exactly as written (their execute
 * bodies are the single source of truth per action); only the model-facing
 * schema collapses, so a 34-tool family costs one schema in the per-turn
 * window instead of 34.
 *
 * Two schema styles:
 *  - `properties` given (office families): flat union schema — args arrive at
 *    the top level, which keeps SecurityLayer pathArgs gating working on
 *    `args.file_path` etc. The `action` key rides along; inner tools ignore it.
 *  - `properties` omitted (protocol): a single free-form `params` object.
 *    Dispatch tolerates both `params: {...}` and flat top-level args.
 *
 * Per-action docs are generated from the inner schemas at module init, so
 * they can't drift from the real parameters.
 */
export interface CollapseFamilyOpts {
  name: string;
  /** Leading paragraph of the collapsed description (what/when, sibling notes). */
  intro: string;
  /** What a medium/weak model sees instead of intro + every action's docs. A
   *  family with `fullActionDocs` runs to thousands of characters, which is
   *  affordable for a frontier model and not for a local one — and the local
   *  model is exactly who needs the family in its set (model-tiers.ts). */
  compactDescription?: string;
  /** action -> inner tool. Key is the model-facing action name. */
  actions: Record<string, ToolDefinition>;
  /** Flat union schema for office-style families. Must include neither
   *  `action` nor `params` — `action` is added here. */
  properties?: Record<string, unknown>;
  /** Required keys beyond `action` (flat style only). */
  required?: string[];
  /** Full inner descriptions in the per-action docs instead of the first
   *  sentence — for families whose descriptions carry formatting contracts
   *  the model must see (office markdown/slide-spec rules). */
  fullActionDocs?: boolean;
}

function actionSignature(tool: ToolDefinition): string {
  const params = tool.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const props = Object.keys(params?.properties ?? {});
  const req = new Set(params?.required ?? []);
  return props.map((p) => (req.has(p) ? p : `${p}?`)).join(", ");
}

function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/s);
  return (m ? m[0] : text).slice(0, 160);
}

/**
 * The arguments a family call hands its action: nested `params` merged over
 * the flat args, so both call shapes work. `params` is the model's own object,
 * so it loses its `_` keys first: the executor's stamps in the flat args
 * (_sessionId, _operationId, …) are the only ones the action may see. A
 * wrapper that reads a family call's arguments uses this too, and passes the
 * call on as it came, because stamps moved into `params` are dropped here.
 */
export function familyActionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, params, ...rest } = args;
  return params && typeof params === "object" && !Array.isArray(params)
    ? { ...rest, ...withoutInternalArgs(params as Record<string, unknown>) }
    : rest;
}

export function collapseFamily(opts: CollapseFamilyOpts): ToolDefinition {
  const actionNames = Object.keys(opts.actions);
  const docs = actionNames.map((a) => {
    const inner = opts.actions[a];
    const body = opts.fullActionDocs ? inner.description : firstSentence(inner.description);
    return `• ${a}(${actionSignature(inner)}): ${body}`;
  });

  const parameters = opts.properties
    ? {
        type: "object",
        properties: {
          action: { type: "string", enum: actionNames, description: "Which operation to run — see per-action docs in the tool description." },
          ...opts.properties,
        },
        required: ["action", ...(opts.required ?? [])],
      }
    : {
        type: "object",
        properties: {
          action: { type: "string", enum: actionNames, description: "Which operation to run — see per-action docs in the tool description." },
          params: { type: "object", description: "Arguments for the chosen action — see the per-action signatures in the tool description." },
        },
        required: ["action"],
      };

  return {
    name: opts.name,
    description: `${opts.intro}\n\nActions:\n${docs.join("\n")}`,
    ...(opts.compactDescription ? { compactDescription: opts.compactDescription } : {}),
    parameters,
    async execute(args, signal): Promise<ToolResult> {
      const action = String(args.action ?? "");
      const inner = opts.actions[action];
      if (!inner) {
        return {
          content: `Unknown action "${action}" for ${opts.name}. Valid actions: ${actionNames.join(", ")}`,
          isError: true,
        };
      }
      return inner.execute(familyActionArgs(args), signal);
    },
  };
}
