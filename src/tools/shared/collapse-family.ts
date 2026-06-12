import type { ToolDefinition, ToolResult } from "../../types.js";

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
      // Merge nested params over flat args so both call shapes work; keep
      // executor-injected underscore keys (_sessionId, …) visible to the inner
      // tool either way.
      const { action: _action, params, ...rest } = args;
      const innerArgs =
        params && typeof params === "object" && !Array.isArray(params)
          ? { ...rest, ...(params as Record<string, unknown>) }
          : rest;
      return inner.execute(innerArgs, signal);
    },
  };
}
