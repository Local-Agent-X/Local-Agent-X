import type { CertificationScenarioId } from "./certification-types.js";

const BASELINE_MARKER = "LAX_CERT_BASE_4D2F";
const CONTINUATION_MARKER = "LAX_CERT_CONT_91A7";
const CONTEXT_MARKER = "LAX_CERT_CTX_62CE";
const TOOL_NAME = "lax_certification_probe";

export interface CertificationScenario {
  id: CertificationScenarioId;
  body(model: string): Record<string, unknown>;
  verify(body: unknown): boolean;
}

function firstChoice(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  return choices[0] as Record<string, unknown>;
}

function message(body: unknown): Record<string, unknown> | null {
  const choice = firstChoice(body);
  const value = choice?.message;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function content(body: unknown): string {
  const value = message(body)?.content;
  return typeof value === "string" ? value : "";
}

function hasToolCall(body: unknown): boolean {
  const calls = message(body)?.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) return false;
  const call = calls[0];
  if (!call || typeof call !== "object") return false;
  const row = call as { type?: unknown; function?: unknown };
  if (row.type !== "function" || !row.function || typeof row.function !== "object") return false;
  const fn = row.function as { name?: unknown; arguments?: unknown };
  if (fn.name !== TOOL_NAME || typeof fn.arguments !== "string") return false;
  try {
    const args = JSON.parse(fn.arguments) as unknown;
    return Boolean(
      args && typeof args === "object" && !Array.isArray(args)
      && (args as { ok?: unknown }).ok === true
      && Object.keys(args).length === 1,
    );
  } catch {
    return false;
  }
}

function baseBody(model: string, messages: unknown[]): Record<string, unknown> {
  return { model, messages, temperature: 0, max_tokens: 256 };
}

export const LOCAL_MODEL_CERTIFICATION_SCENARIOS: readonly CertificationScenario[] = [
  {
    id: "baseline_marker",
    body: (model) => baseBody(model, [{ role: "user", content: `Reply with exactly ${BASELINE_MARKER}` }]),
    verify: (body) => content(body).trim() === BASELINE_MARKER,
  },
  {
    id: "strict_json_schema",
    body: (model) => ({
      ...baseBody(model, [{ role: "user", content: "Return the required JSON object." }]),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "certification",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean", const: true } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    }),
    verify: (body) => {
      try {
        const parsed = JSON.parse(content(body)) as { ok?: unknown };
        return parsed.ok === true && Object.keys(parsed).length === 1;
      } catch {
        return false;
      }
    },
  },
  {
    id: "required_tool_call",
    body: (model) => ({
      ...baseBody(model, [{ role: "user", content: "Call the certification tool now." }]),
      tools: [{
        type: "function",
        function: {
          name: TOOL_NAME,
          description: "Return the fixed certification result.",
          parameters: {
            type: "object",
            properties: { ok: { type: "boolean", const: true } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    }),
    verify: hasToolCall,
  },
  {
    id: "tool_result_continuation",
    body: (model) => baseBody(model, [
      { role: "user", content: "Complete the certification after the tool result." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "cert_call_1",
          type: "function",
          function: { name: TOOL_NAME, arguments: "{\"ok\":true}" },
        }],
      },
      { role: "tool", tool_call_id: "cert_call_1", content: "{\"ok\":true}" },
      { role: "user", content: `Reply with exactly ${CONTINUATION_MARKER}` },
    ]),
    verify: (body) => content(body).trim() === CONTINUATION_MARKER,
  },
  {
    id: "context_degradation",
    body: (model) => baseBody(model, [
      { role: "user", content: `${"probe ".repeat(4_096)}\nReply with exactly ${CONTEXT_MARKER}` },
    ]),
    verify: (body) => content(body).trim() === CONTEXT_MARKER,
  },
];
