import type { ToolDefinition, ToolResult } from "./types.js";

export const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    "Ask the user a question and wait for their response. " +
    "Use when you need clarification, confirmation, or a choice before proceeding.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional multiple-choice options to present",
      },
      context: {
        type: "string",
        description: "Background context explaining why you are asking",
      },
    },
    required: ["question"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const question = String(args.question ?? "");
    if (!question) return { content: "Error: question is required.", isError: true };

    const options = Array.isArray(args.options)
      ? (args.options as string[]).map(String)
      : undefined;
    const context = args.context ? String(args.context) : undefined;

    const parts = [question];
    if (context) parts.push(`Context: ${context}`);
    if (options?.length) parts.push(`Options: ${options.join(", ")}`);

    return {
      content: parts.join("\n"),
      metadata: {
        askUser: true,
        question,
        ...(options && { options }),
        ...(context && { context }),
      },
    };
  },
};

export const askUserToolEnhancements = {
  category: "system" as const,
  tags: ["ask", "question", "user", "input", "clarify"],
  readOnly: true,
  concurrencySafe: false,
  defer: false,
  searchHint: "ask user a question for clarification",
};
